package cmd

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"text/tabwriter"
	"text/template"
	"time"

	"github.com/spf13/cobra"
	"github.com/spore-host/spore-host/pkg/catalog"
	spawnclient "github.com/spore-host/spore-host/spawn/pkg/aws"
	"github.com/spore-host/spore-host/spawn/pkg/platform"
)

// ── app command flags ────────────────────────────────────────────────────────

var (
	appLaunchName         string
	appLaunchInstanceType string
	appLaunchRegion       string
	appLaunchSpot         bool
	appLaunchTTL          string
	appLaunchIdleTimeout  string
	appLaunchNoOpen       bool // --no-open: write session file but don't open browser
)

// ── command tree ─────────────────────────────────────────────────────────────

var appGroupCmd = &cobra.Command{
	Use:   "app",
	Short: "Launch and manage catalog applications via NICE DCV",
	Long: `Launch streamable research applications in the cloud.

Each application is pre-configured with the right instance type, NICE DCV
for browser-based streaming, and automatic idle termination.

Examples:
  spawn app list                       # show available apps
  spawn app launch paraview            # launch ParaView on a GPU instance
  spawn app launch igv --region us-west-2
  spawn app launch paraview --spot --ttl 4h`,
}

var appListCmd = &cobra.Command{
	Use:   "list",
	Short: "List all streamable applications in the catalog",
	RunE:  runAppList,
}

var appLaunchCmd = &cobra.Command{
	Use:   "launch <app-name>",
	Short: "Launch a catalog application via NICE DCV",
	Args:  cobra.ExactArgs(1),
	RunE:  runAppLaunch,
}

func init() {
	rootCmd.AddCommand(appGroupCmd)
	appGroupCmd.AddCommand(appListCmd, appLaunchCmd)

	appLaunchCmd.Flags().StringVar(&appLaunchName, "name", "", "Session name (default: <app>-<timestamp>)")
	appLaunchCmd.Flags().StringVar(&appLaunchInstanceType, "instance-type", "", "Override instance type (default: first catalog family + .xlarge)")
	appLaunchCmd.Flags().StringVar(&appLaunchRegion, "region", "", "AWS region (default: from AWS config)")
	appLaunchCmd.Flags().BoolVar(&appLaunchSpot, "spot", false, "Use Spot pricing")
	appLaunchCmd.Flags().StringVar(&appLaunchTTL, "ttl", "", "Hard termination deadline (e.g. 4h, 8h)")
	appLaunchCmd.Flags().StringVar(&appLaunchIdleTimeout, "idle-timeout", "", "Stop when DCV has no clients for this duration (default: catalog default)")
	appLaunchCmd.Flags().BoolVar(&appLaunchNoOpen, "no-open", false, "Write session file but do not open browser automatically")
}

// ── spawn app list ────────────────────────────────────────────────────────────

func runAppList(cmd *cobra.Command, args []string) error {
	apps := catalog.List()
	if len(apps) == 0 {
		fmt.Fprintln(os.Stderr, "No applications in catalog.")
		return nil
	}

	w := tabwriter.NewWriter(os.Stdout, 0, 0, 2, ' ', 0)
	fmt.Fprintln(w, "NAME\tDESCRIPTION\tGPU\tFAMILIES\tLICENSE")
	for _, app := range apps {
		gpu := "no"
		if app.GPU {
			gpu = "yes"
		}
		fmt.Fprintf(w, "%s\t%s\t%s\t%s\t%s\n",
			app.Name,
			app.Description,
			gpu,
			strings.Join(app.InstanceFamilies, ", "),
			app.License,
		)
	}
	return w.Flush()
}

// ── spawn app launch ──────────────────────────────────────────────────────────

func runAppLaunch(cmd *cobra.Command, args []string) error {
	ctx := context.Background()
	appArg := args[0]

	// 1. Resolve catalog entry
	entry, ok := catalog.Lookup(appArg)
	if !ok {
		return fmt.Errorf("application %q not found in catalog — run 'spawn app list' to see available apps", appArg)
	}

	fmt.Fprintf(os.Stderr, "Launching %s — %s\n", entry.Name, entry.Description)

	// 2. Create AWS client
	client, err := spawnclient.NewClient(ctx)
	if err != nil {
		return fmt.Errorf("create AWS client: %w", err)
	}

	// 3. Resolve region
	region := appLaunchRegion
	if region == "" {
		// Use the client's configured region
		cfg, err := client.GetConfig(ctx)
		if err != nil || cfg.Region == "" {
			region = "us-east-1"
		} else {
			region = cfg.Region
		}
	}

	// 4. Pick instance type
	instanceType := appLaunchInstanceType
	if instanceType == "" {
		if len(entry.InstanceFamilies) == 0 {
			return fmt.Errorf("no instance families defined for %s in catalog", entry.Name)
		}
		instanceType = entry.InstanceFamilies[0] + ".xlarge"
		fmt.Fprintf(os.Stderr, "Instance type: %s (default; override with --instance-type)\n", instanceType)
	}

	// 5. AMI selection: catalog first, then GetRecommendedAMI
	ami := ""
	if entry.AMIs != nil {
		ami = entry.AMIs[region]
	}
	if ami == "" {
		fmt.Fprintf(os.Stderr, "No catalog AMI for %s in %s — using standard AL2023 AMI (install DCV manually or build catalog AMIs via infra/amis/build.sh)\n", entry.Name, region)
		// Use standard x86 AL2023 — GPU-specific SSM paths don't exist for AL2023.
		// Catalog AMIs (built via infra/amis/) will replace this once published (#286).
		ami, err = client.GetAL2023AMI(ctx, region, "x86_64", false)
		if err != nil {
			return fmt.Errorf("get AL2023 AMI: %w", err)
		}
	}

	// 6. Session name
	sessionName := appLaunchName
	if sessionName == "" {
		sessionName = fmt.Sprintf("%s-%d", entry.Name, time.Now().Unix())
	}

	// 7. Idle timeout: flag > catalog default > none
	idleTimeout := appLaunchIdleTimeout
	if idleTimeout == "" && entry.IdleTimeoutDefault != "" {
		idleTimeout = entry.IdleTimeoutDefault
		fmt.Fprintf(os.Stderr, "Idle timeout: %s (from catalog; override with --idle-timeout)\n", idleTimeout)
	}

	// 8. SSH key pair — resolve local key and import to AWS if needed
	plat, err := platform.Detect()
	if err != nil {
		return fmt.Errorf("detect platform: %w", err)
	}
	keyName, err := setupSSHKey(ctx, client, region, plat)
	if err != nil {
		fmt.Fprintf(os.Stderr, "⚠️  SSH key setup failed: %v — launching without key (DCV only)\n", err)
		keyName = ""
	}

	// 9. Security group for DCV (port 8443)
	vpcID, err := client.GetDefaultVPC(ctx, region)
	if err != nil {
		return fmt.Errorf("get default VPC: %w", err)
	}
	dcvSGID, err := client.CreateOrGetDCVSecurityGroup(ctx, region, vpcID)
	if err != nil {
		return fmt.Errorf("create DCV security group: %w", err)
	}
	fmt.Fprintf(os.Stderr, "Security group: %s (spawn-dcv, port 8443 open)\n", dcvSGID)

	// 9. DCV session ID (fixed "console" — DCV default session name)
	dcvSessionID := "console"

	// 10. DCV user-data: start DCV server + create session
	dcvUserData := buildDCVUserData(entry.LaunchCommand, dcvSessionID)

	// 13. Build LaunchConfig
	lc := spawnclient.LaunchConfig{
		Name:             sessionName,
		InstanceType:     instanceType,
		Region:           region,
		AMI:              ami,
		KeyName:          keyName,
		Spot:             appLaunchSpot,
		TTL:              appLaunchTTL,
		IdleTimeout:      idleTimeout,
		OnComplete:       "stop", // stop (not terminate) so session can be restarted
		SecurityGroupIDs: []string{dcvSGID},
		UserData:         dcvUserData,
		DCVSessionID:     dcvSessionID,
		AppName:          entry.Name,
	}

	// 12. Launch
	fmt.Fprintf(os.Stderr, "Launching %s in %s...\n", instanceType, region)
	result, err := client.Launch(ctx, lc)
	if err != nil {
		return fmt.Errorf("launch failed: %w", err)
	}

	fmt.Fprintf(os.Stderr, "Instance: %s (%s)\n", result.InstanceID, result.PublicIP)

	// 13. Determine host (DNS name if available, else public IP)
	host := result.PublicIP
	// DNS name will be registered by spored once the instance starts; use it if available
	dnsName := sessionName
	if host != "" {
		fmt.Fprintf(os.Stderr, "Waiting for DCV to become ready at https://%s:8443...\n", host)
		if err := waitForDCV(ctx, host, 3*time.Minute); err != nil {
			fmt.Fprintf(os.Stderr, "⚠️  DCV not ready yet: %v\nSession file will auto-reconnect once it starts.\n", err)
		}
	}

	// 14. Write session HTML file
	sessionFile, err := writeSessionHTML(result.InstanceID, sessionName, dnsName, host, entry.Name, entry.Description, instanceType)
	if err != nil {
		fmt.Fprintf(os.Stderr, "⚠️  Failed to write session file: %v\n", err)
	} else {
		fmt.Fprintf(os.Stdout, "\n✅  %s is ready\n", entry.Name)
		fmt.Fprintf(os.Stdout, "   Session: %s\n", sessionName)
		fmt.Fprintf(os.Stdout, "   File:    %s\n", sessionFile)
		fmt.Fprintf(os.Stdout, "   Reconnect: spawn app launch %s --name %s\n\n", entry.Name, sessionName)

		// 15. Open in browser
		if !appLaunchNoOpen {
			if err := openBrowser(sessionFile); err != nil {
				fmt.Fprintf(os.Stderr, "⚠️  Could not open browser automatically: %v\n", err)
				fmt.Fprintf(os.Stderr, "   Open manually: file://%s\n", sessionFile)
			}
		}
	}

	return nil
}

// ── helpers ───────────────────────────────────────────────────────────────────

// buildDCVUserData returns a base64-encoded user-data script that starts DCV and creates a session.
// spored is already pre-installed in the catalog AMI.
func buildDCVUserData(launchCommand, sessionID string) string {
	script := fmt.Sprintf(`#!/bin/bash
set -e

# Start NICE DCV server
systemctl enable dcvserver
systemctl start dcvserver

# Wait for DCV to initialize
sleep 15

# Create application streaming session
dcv create-session \
    --name %s \
    --owner root \
    --init %q \
    %s 2>/dev/null || true

echo "DCV session '%s' created for: %s"
`, sessionID, launchCommand, sessionID, sessionID, launchCommand)
	return base64.StdEncoding.EncodeToString([]byte(script))
}

// waitForDCV polls the DCV endpoint until it responds or the timeout is exceeded.
func waitForDCV(ctx context.Context, host string, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	client := &http.Client{Timeout: 5 * time.Second}
	url := fmt.Sprintf("https://%s:8443", host)

	for time.Now().Before(deadline) {
		select {
		case <-ctx.Done():
			return ctx.Err()
		default:
		}
		// DCV returns a page even with TLS errors; we just need TCP open
		resp, err := client.Get(url) //nolint:noctx
		if err == nil {
			resp.Body.Close()
			return nil
		}
		// Connection refused → keep waiting; TLS error → DCV is up
		if strings.Contains(err.Error(), "tls") || strings.Contains(err.Error(), "certificate") {
			return nil
		}
		time.Sleep(10 * time.Second)
	}
	return fmt.Errorf("DCV not ready after %v", timeout)
}

// getSessionsDir returns the path to ~/.spawn/sessions/, creating it if necessary.
func getSessionsDir() (string, error) {
	homeDir, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("get home directory: %w", err)
	}
	dir := filepath.Join(homeDir, ".spawn", "sessions")
	if err := os.MkdirAll(dir, 0755); err != nil {
		return "", fmt.Errorf("create sessions directory: %w", err)
	}
	return dir, nil
}

// findSessionFile scans the sessions directory for an HTML file containing instanceID.
// Returns the file path if found, empty string otherwise.
func findSessionFile(dir, instanceID string) string {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return ""
	}
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".html") {
			continue
		}
		path := filepath.Join(dir, e.Name())
		data, err := os.ReadFile(path)
		if err == nil && strings.Contains(string(data), instanceID) {
			return path
		}
	}
	return ""
}

// writeSessionHTML writes the DCV session HTML file to ~/.spawn/sessions/ and returns the path.
func writeSessionHTML(instanceID, sessionName, dnsName, publicIP, appName, appDesc, instanceType string) (string, error) {
	dir, err := getSessionsDir()
	if err != nil {
		return "", err
	}

	// Generate a short random session ID for the file name and tab title
	b := make([]byte, 4)
	_, _ = rand.Read(b)
	shortID := hex.EncodeToString(b)

	host := dnsName
	if publicIP != "" {
		host = publicIP
	}

	data := sessionHTMLData{
		SessionID:    shortID,
		InstanceID:   instanceID,
		AppName:      appName,
		AppDesc:      appDesc,
		InstanceType: instanceType,
		Host:         host,
		DCVPort:      8443,
		LaunchedAt:   time.Now().Format("2006-01-02 15:04 UTC"),
	}

	tmpl, err := template.New("session").Parse(sessionHTMLTemplate)
	if err != nil {
		return "", fmt.Errorf("parse template: %w", err)
	}

	path := filepath.Join(dir, fmt.Sprintf("%s-%s.html", appName, shortID))
	f, err := os.Create(path)
	if err != nil {
		return "", fmt.Errorf("create session file: %w", err)
	}
	defer f.Close()

	if err := tmpl.Execute(f, data); err != nil {
		return "", fmt.Errorf("write session file: %w", err)
	}

	return path, nil
}

type sessionHTMLData struct {
	SessionID    string
	InstanceID   string
	AppName      string
	AppDesc      string
	InstanceType string
	Host         string
	DCVPort      int
	LaunchedAt   string
}

// openBrowser opens a file or URL in the default browser.
func openBrowser(path string) error {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		cmd = exec.Command("open", path)
	case "linux":
		cmd = exec.Command("xdg-open", path)
	case "windows":
		cmd = exec.Command("cmd", "/c", "start", path)
	default:
		return fmt.Errorf("unsupported OS: %s", runtime.GOOS)
	}
	return cmd.Start()
}

// ── session HTML template ─────────────────────────────────────────────────────

// sessionHTMLTemplate is the DCV session wrapper page.
// Title format "spore:<id> — <app>" enables tab reuse detection by spawn connect.
var sessionHTMLTemplate = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>spore:{{.SessionID}} — {{.AppName}} ({{.InstanceID}})</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
           background: #0f0f0f; color: #e0e0e0; height: 100vh; display: flex; flex-direction: column; }
    #dcv-container { flex: 1; width: 100%; border: none; }
    #status { position: fixed; top: 0; left: 0; right: 0; bottom: 0;
              display: flex; flex-direction: column; align-items: center; justify-content: center;
              background: #0f0f0f; z-index: 10; }
    #status.hidden { display: none; }
    .spinner { width: 48px; height: 48px; border: 4px solid #333;
               border-top: 4px solid #42d4d4; border-radius: 50%;
               animation: spin 1s linear infinite; margin-bottom: 1.5rem; }
    @keyframes spin { to { transform: rotate(360deg); } }
    h2 { font-size: 1.4rem; font-weight: 600; margin-bottom: 0.5rem; }
    p  { color: #888; font-size: 0.9rem; margin-bottom: 1.5rem; }
    .btn { background: #4059e5; color: #fff; border: none; padding: 0.65rem 1.4rem;
           border-radius: 8px; font-size: 0.9rem; font-weight: 600; cursor: pointer; }
    .btn:hover { opacity: 0.85; }
    footer { position: fixed; bottom: 0; left: 0; right: 0; padding: 0.4rem 1rem;
             background: rgba(0,0,0,0.6); font-size: 0.75rem; color: #555;
             display: flex; justify-content: space-between; }
  </style>
</head>
<body>
  <div id="status">
    <div class="spinner"></div>
    <h2 id="status-title">Connecting to {{.AppName}}…</h2>
    <p id="status-msg">Starting your session on {{.InstanceType}} ({{.Host}})</p>
    <button class="btn" id="restart-btn" style="display:none"
            onclick="restartSession()">Restart Session</button>
  </div>

  <div id="dcv-container"></div>

  <footer>
    <span>spore:{{.SessionID}} — {{.AppName}} ({{.InstanceType}}) — launched {{.LaunchedAt}}</span>
    <span>Instance: {{.InstanceID}}</span>
  </footer>

  <script>
  // DCV Web Client SDK — loaded lazily to avoid blocking the page
  const DCV_HOST = '{{.Host}}';
  const DCV_PORT = {{.DCVPort}};
  const SESSION_ID = '{{.SessionID}}';
  const APP_NAME   = '{{.AppName}}';

  const sdkURL = 'https://d1uj6qtbmh3dt5.cloudfront.net/2024.0/Clients/dcv-web-client.js';

  function setStatus(title, msg, showRestart) {
    document.getElementById('status-title').textContent = title;
    document.getElementById('status-msg').textContent   = msg;
    document.getElementById('restart-btn').style.display = showRestart ? 'inline-block' : 'none';
    document.getElementById('status').classList.remove('hidden');
  }

  function hideStatus() {
    document.getElementById('status').classList.add('hidden');
  }

  function restartSession() {
    setStatus('Restarting…', 'Waiting for the instance to wake up…', false);
    // Reload the page — the DCV polling loop will reconnect once DCV responds
    location.reload();
  }

  async function tryConnect() {
    // Poll until DCV responds, then load the SDK and connect
    const dcvBase = 'https://' + DCV_HOST + ':' + DCV_PORT;
    setStatus('Connecting to ' + APP_NAME + '…', 'Waiting for DCV at ' + dcvBase, false);

    for (let i = 0; i < 60; i++) {
      try {
        await fetch(dcvBase + '/favicon.ico', { mode: 'no-cors', signal: AbortSignal.timeout(4000) });
        break; // DCV is up
      } catch (_) {
        await new Promise(r => setTimeout(r, 5000));
      }
    }

    // Load DCV Web Client SDK
    await new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = sdkURL;
      s.onload = resolve;
      s.onerror = reject;
      document.head.appendChild(s);
    });

    // Connect
    try {
      const conn = await dcv.connect({
        url:            dcvBase,
        sessionId:      'console',
        authToken:      '',
        divId:          'dcv-container',
        callbacks: {
          ready: hideStatus,
          disconnect: (reason) => {
            const msgs = {
              'idle':    ['Session ended — idle timeout', 'The instance was stopped after ' + APP_NAME + ' was idle.'],
              'ttl':     ['Session ended — time limit reached', 'The instance reached its TTL and was stopped.'],
            };
            const [title, msg] = msgs[reason] || ['Session disconnected', 'The DCV session ended: ' + reason];
            setStatus(title, msg, true);
          },
        },
      });
    } catch (e) {
      setStatus('Connection failed', e.message || 'Could not connect to DCV.', true);
    }
  }

  tryConnect();
  </script>
</body>
</html>
`
