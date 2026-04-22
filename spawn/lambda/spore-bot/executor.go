package main

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/credentials/stscreds"
	"github.com/aws/aws-sdk-go-v2/service/ec2"
	ec2types "github.com/aws/aws-sdk-go-v2/service/ec2/types"
	"github.com/aws/aws-sdk-go-v2/service/sts"
)

// BotAction is the payload passed from Phase 1 (ACK) to Phase 2 (execute).
type BotAction struct {
	Platform     string           `json:"platform"`
	WorkspaceID  string           `json:"workspace_id"`
	UserID       string           `json:"user_id"`
	ResponseURL  string           `json:"response_url"`
	Command      string           `json:"command"`       // "status","start","stop","hibernate","url","list","help","connect"
	Nickname     string           `json:"nickname"`      // may be empty (single-instance case)
	SlashCommand string           `json:"slash_command"` // e.g. "/spore" or "/prism" — from Slack payload
	Registration *BotRegistration `json:"registration"`
}

// slashCmd returns the slash command name (e.g. "/spore"), defaulting to "/prism".
func (a *BotAction) slashCmd() string {
	if a.SlashCommand != "" {
		return a.SlashCommand
	}
	return "/prism"
}

// executeAction runs the EC2 operation, posts the result to the chat platform,
// and logs an audit event regardless of outcome.
func executeAction(ctx context.Context, cfg aws.Config, reg *Registry, action *BotAction) {
	var result string
	var err error
	auditResult := AuditResultSuccess

	switch action.Command {
	case "connect":
		result, err = cmdConnect(ctx, reg, action)
	case "list":
		result, err = cmdList(ctx, reg, action)
	case "notify":
		result, err = cmdNotify(ctx, reg, action)
	case "unnotify":
		result, err = cmdUnnotify(ctx, reg, action)
	case "help":
		result = helpText(action.slashCmd())
	case "status":
		result, err = cmdEC2Op(ctx, cfg, action, "status")
	case "start":
		result, err = cmdEC2Op(ctx, cfg, action, "start")
	case "stop":
		result, err = cmdEC2Op(ctx, cfg, action, "stop")
	case "hibernate":
		result, err = cmdEC2Op(ctx, cfg, action, "hibernate")
	case "url":
		result, err = cmdEC2Op(ctx, cfg, action, "url")
	default:
		result = fmt.Sprintf("Unknown command: `%s`. Try `/prism help`.", action.Command)
		auditResult = AuditResultDenied
	}

	detail := ""
	if err != nil {
		result = fmt.Sprintf("❌ Error: %s", err.Error())
		auditResult = AuditResultError
		detail = err.Error()
	} else if strings.HasPrefix(result, "⚠️") {
		auditResult = AuditResultNotEnabled
		detail = result
	} else if strings.HasPrefix(result, "❌") {
		auditResult = AuditResultDenied
		detail = result
	}

	// Audit log is fire-and-forget — never blocks the response to Slack/Teams
	if auditor != nil {
		auditor.Log(ctx, newAuditEvent(action, auditResult, detail))
	}

	// For stop/hibernate, the Phase 1 ACK is the only user-facing message on success.
	// For start, Phase 2 posts the full status card once the instance is running.
	silentOnSuccess := action.Command == "stop" || action.Command == "hibernate"
	if silentOnSuccess && auditResult == AuditResultSuccess {
		return
	}

	// Post result back to the chat platform
	if err := postResponse(action.Platform, action.ResponseURL, result); err != nil {
		logf("failed to post response: %v", err)
	}
}

// resolveRegistration finds the right registration, prompting if ambiguous.
// Matches in order: nickname → instance ID → registered DNS → IP / EC2 tags.
func resolveRegistration(ctx context.Context, reg *Registry, action *BotAction) (*BotRegistration, string, error) {
	regs, err := reg.ListUserInstances(ctx, action.Platform, action.WorkspaceID, action.UserID)
	if err != nil {
		return nil, "", err
	}
	if len(regs) == 0 {
		return nil, "", fmt.Errorf("no instances registered. Run `spawn bot register` to register one")
	}

	// No target given — return single instance or prompt
	if action.Nickname == "" {
		if len(regs) == 1 {
			return &regs[0], "", nil
		}
		names := make([]string, len(regs))
		for i, r := range regs {
			names[i] = r.Nickname
		}
		return nil, fmt.Sprintf("You have multiple instances: %s\nUse `%s %s <nickname>` to specify one.",
			strings.Join(names, ", "), action.slashCmd(), action.Command), nil
	}

	target := action.Nickname

	// 1. Nickname (exact, case-insensitive)
	for i := range regs {
		if strings.EqualFold(regs[i].Nickname, target) {
			return &regs[i], "", nil
		}
	}
	// 2. Instance ID
	for i := range regs {
		if strings.EqualFold(regs[i].InstanceID, target) {
			return &regs[i], "", nil
		}
	}
	// 3. Registered DNS name
	for i := range regs {
		if regs[i].DNSName != "" && strings.EqualFold(regs[i].DNSName, target) {
			return &regs[i], "", nil
		}
	}
	// 4. IP address or live EC2 tags (Name, spawn:dns-name, constructed DNS)
	if matched := matchByEC2(ctx, regs, target); matched != nil {
		return matched, "", nil
	}

	return nil, fmt.Sprintf("No instance named `%s`. Your instances: %s",
		action.Nickname, registrationNames(regs)), nil
}

// matchByEC2 resolves a target against live EC2 data: public IP, EC2 Name tag,
// spawn:dns-name tag, or constructed full DNS name ({name}.{base36}.spore.host).
func matchByEC2(ctx context.Context, regs []BotRegistration, target string) *BotRegistration {
	for i := range regs {
		r := &regs[i]
		if r.RoleARN == "" {
			continue
		}
		ec2Client, err := crossAccountEC2(ctx, cfg, r.RoleARN, r.InstanceID)
		if err != nil {
			continue
		}
		out, err := ec2Client.DescribeInstances(ctx, &ec2.DescribeInstancesInput{
			InstanceIds: []string{r.InstanceID},
		})
		if err != nil || len(out.Reservations) == 0 || len(out.Reservations[0].Instances) == 0 {
			continue
		}
		inst := out.Reservations[0].Instances[0]

		// Match public IP
		if inst.PublicIpAddress != nil && *inst.PublicIpAddress == target {
			return r
		}
		// Collect tags
		var dnsShort, accountBase36 string
		for _, tag := range inst.Tags {
			if tag.Key == nil || tag.Value == nil {
				continue
			}
			switch *tag.Key {
			case "Name":
				if strings.EqualFold(*tag.Value, target) {
					return r
				}
			case r.TagPrefix + ":dns-name":
				dnsShort = *tag.Value
			case r.TagPrefix + ":account-base36":
				accountBase36 = *tag.Value
			}
		}
		// Match short DNS name or constructed full name
		if dnsShort != "" {
			if strings.EqualFold(dnsShort, target) {
				return r
			}
			if accountBase36 != "" {
				full := dnsShort + "." + accountBase36 + ".spore.host"
				if strings.EqualFold(full, target) {
					return r
				}
			}
		}
	}
	return nil
}

func registrationNames(regs []BotRegistration) string {
	names := make([]string, len(regs))
	for i, r := range regs {
		names[i] = r.Nickname
	}
	return strings.Join(names, ", ")
}

func cmdList(ctx context.Context, reg *Registry, action *BotAction) (string, error) {
	regs, err := reg.ListUserInstances(ctx, action.Platform, action.WorkspaceID, action.UserID)
	if err != nil {
		return "", err
	}
	if len(regs) == 0 {
		return fmt.Sprintf("No instances registered. Use `%s notify <name>` to subscribe to notifications, or ask your workspace admin to run `spawn bot register`.", action.slashCmd()), nil
	}

	var control, notify []string
	for _, r := range regs {
		if r.NotifyOnly {
			name := strings.TrimPrefix(r.Nickname, "notify::")
			notify = append(notify, fmt.Sprintf("• 🔔 *%s* — `%s` _(notifications only)_", name, r.InstanceID))
		} else {
			line := fmt.Sprintf("• *%s* — `%s`", r.Nickname, r.InstanceID)
			if r.DNSName != "" {
				line += fmt.Sprintf(" (%s)", r.DNSName)
			}
			if len(r.AllowedActions) > 0 {
				line += fmt.Sprintf(" [%s]", strings.Join(r.AllowedActions, ", "))
			}
			control = append(control, line)
		}
	}

	var lines []string
	if len(control) > 0 {
		lines = append(lines, "*Your instances:*")
		lines = append(lines, control...)
	}
	if len(notify) > 0 {
		lines = append(lines, "*Your notification subscriptions:*")
		lines = append(lines, notify...)
	}
	return strings.Join(lines, "\n"), nil
}

func cmdEC2Op(ctx context.Context, cfg aws.Config, action *BotAction, op string) (string, error) {
	reg := action.Registration
	if reg == nil {
		return "", fmt.Errorf("no registration provided")
	}

	// Enabled is the explicit opt-in gate — off by default after registration.
	if !reg.Enabled {
		return fmt.Sprintf("⚠️ *%s* (`%s`) is registered but not enabled for bot access.\n"+
			"The workspace admin must run:\n```\nspawn bot enable --platform %s --user-id <user-id> --workspace-id <workspace-id> --nickname %s\n```",
			reg.Nickname, reg.InstanceID, reg.Platform, reg.Nickname), nil
	}

	if !isActionAllowed(reg, op) {
		return fmt.Sprintf("❌ Action `%s` is not allowed for `%s`.", op, reg.Nickname), nil
	}

	// Assume cross-account role for this instance's AWS account
	ec2Client, err := crossAccountEC2(ctx, cfg, reg.RoleARN, reg.InstanceID)
	if err != nil {
		return "", fmt.Errorf("assume role: %w", err)
	}

	switch op {
	case "status":
		return getStatus(ctx, ec2Client, reg)
	case "start":
		return startInstance(ctx, ec2Client, reg)
	case "stop":
		return stopInstance(ctx, ec2Client, reg, false)
	case "hibernate":
		return stopInstance(ctx, ec2Client, reg, true)
	case "url":
		return getURL(ctx, ec2Client, reg)
	}
	return "", fmt.Errorf("unknown op: %s", op)
}

func crossAccountEC2(ctx context.Context, cfg aws.Config, roleARN, instanceID string) (*ec2.Client, error) {
	stsClient := sts.NewFromConfig(cfg)
	creds := stscreds.NewAssumeRoleProvider(stsClient, roleARN, func(o *stscreds.AssumeRoleOptions) {
		o.RoleSessionName = "spore-bot-" + instanceID
		// ExternalId matches what bot-cross-account-role.yaml sets in the trust policy
		externalID := getEnv("BOT_EXTERNAL_ID", "spawn-bot")
		o.ExternalID = aws.String(externalID)
	})
	ec2Cfg, err := awsconfig.LoadDefaultConfig(ctx, awsconfig.WithCredentialsProvider(creds))
	if err != nil {
		return nil, fmt.Errorf("load cross-account config: %w", err)
	}
	return ec2.NewFromConfig(ec2Cfg), nil
}

func getStatus(ctx context.Context, client *ec2.Client, reg *BotRegistration) (string, error) {
	out, err := client.DescribeInstances(ctx, &ec2.DescribeInstancesInput{
		InstanceIds: []string{reg.InstanceID},
	})
	if err != nil {
		return "", fmt.Errorf("describe instance: %w", err)
	}
	if len(out.Reservations) == 0 || len(out.Reservations[0].Instances) == 0 {
		return fmt.Sprintf("Instance `%s` not found.", reg.InstanceID), nil
	}
	inst := out.Reservations[0].Instances[0]
	state := string(inst.State.Name)

	// Distinguish hibernated from stopped using StateReason.Code.
	// Both show State.Name = "stopped"; the difference is:
	//   Client.UserInitiatedHibernate → hibernated (RAM saved to EBS)
	//   Client.UserInitiatedShutdown  → stopped normally
	if state == "stopped" && inst.StateReason != nil && inst.StateReason.Code != nil {
		if *inst.StateReason.Code == "Client.UserInitiatedHibernate" {
			state = "hibernated"
		}
	}

	ip := ""
	if inst.PublicIpAddress != nil {
		ip = *inst.PublicIpAddress
	}

	// Collect useful tags
	displayName := reg.Nickname
	var dnsShort, accountBase36, ttl, idleTimeout string
	for _, tag := range inst.Tags {
		if tag.Key == nil || tag.Value == nil {
			continue
		}
		switch *tag.Key {
		case reg.TagPrefix + ":name":
			displayName = *tag.Value
		case reg.TagPrefix + ":dns-name":
			dnsShort = *tag.Value
		case reg.TagPrefix + ":account-base36":
			accountBase36 = *tag.Value
		case reg.TagPrefix + ":ttl":
			ttl = *tag.Value
		case reg.TagPrefix + ":idle-timeout":
			idleTimeout = *tag.Value
		case "Name":
			if displayName == reg.Nickname {
				displayName = *tag.Value
			}
		}
	}

	dnsName := reg.DNSName
	if dnsName == "" && dnsShort != "" && accountBase36 != "" {
		dnsName = dnsShort + "." + accountBase36 + ".spore.host"
	}

	launchTime := ""
	if inst.LaunchTime != nil {
		launchTime = inst.LaunchTime.Format(time.RFC3339)
	}

	az := ""
	if inst.Placement != nil && inst.Placement.AvailabilityZone != nil {
		az = *inst.Placement.AvailabilityZone
	}

	return formatSlackStatus(InstanceStatus{
		Nickname:     displayName,
		InstanceID:   reg.InstanceID,
		State:        state,
		InstanceType: string(inst.InstanceType),
		AZ:           az,
		IP:           ip,
		DNSName:      dnsName,
		LaunchTime:   launchTime,
		TTL:          ttl,
		IdleTimeout:  idleTimeout,
	}), nil
}

func startInstance(ctx context.Context, client *ec2.Client, reg *BotRegistration) (string, error) {
	_, err := client.StartInstances(ctx, &ec2.StartInstancesInput{
		InstanceIds: []string{reg.InstanceID},
	})
	if err != nil {
		return "", fmt.Errorf("start instance: %w", err)
	}

	// Poll until running (up to 90s), then return the full status card.
	// The Lambda timeout is set to 120s to accommodate this.
	deadline := time.Now().Add(90 * time.Second)
	for time.Now().Before(deadline) {
		time.Sleep(6 * time.Second)
		status, err := getStatus(ctx, client, reg)
		if err != nil {
			continue
		}
		// Once running, the status card has the IP and URL — return it directly
		if strings.Contains(status, "Running") {
			return status, nil
		}
	}

	// Took longer than 90s — post a nudge instead of the full card
	return fmt.Sprintf("▶️ *%s* is starting — it's taking a little longer than usual.\nUse `%s status %s` to check when it's ready.",
		reg.Nickname, "/spore", reg.Nickname), nil
}

func stopInstance(ctx context.Context, client *ec2.Client, reg *BotRegistration, hibernate bool) (string, error) {
	input := &ec2.StopInstancesInput{
		InstanceIds: []string{reg.InstanceID},
	}
	if hibernate {
		input.Hibernate = aws.Bool(true)
	}
	_, err := client.StopInstances(ctx, input)
	if err != nil {
		// Hibernate may fail if not supported — fall back to stop
		if hibernate && strings.Contains(err.Error(), "hibern") {
			input.Hibernate = aws.Bool(false)
			_, err = client.StopInstances(ctx, input)
			if err != nil {
				return "", fmt.Errorf("stop instance: %w", err)
			}
			return fmt.Sprintf("⏹️ Stopped *%s* (`%s`) (hibernation not supported on this instance).", reg.Nickname, reg.InstanceID), nil
		}
		return "", fmt.Errorf("stop instance: %w", err)
	}
	if hibernate {
		return fmt.Sprintf("💤 Hibernating *%s* (`%s`)... RAM state saved, billing paused.", reg.Nickname, reg.InstanceID), nil
	}
	return fmt.Sprintf("⏹️ Stopping *%s* (`%s`)...", reg.Nickname, reg.InstanceID), nil
}

func getURL(ctx context.Context, client *ec2.Client, reg *BotRegistration) (string, error) {
	if reg.DNSName != "" {
		return fmt.Sprintf("🔗 *%s*: https://%s", reg.Nickname, reg.DNSName), nil
	}
	// Fall back to public IP
	out, err := client.DescribeInstances(ctx, &ec2.DescribeInstancesInput{
		InstanceIds: []string{reg.InstanceID},
	})
	if err != nil {
		return "", fmt.Errorf("describe instance: %w", err)
	}
	if len(out.Reservations) == 0 || len(out.Reservations[0].Instances) == 0 {
		return fmt.Sprintf("Instance `%s` not found.", reg.InstanceID), nil
	}
	inst := out.Reservations[0].Instances[0]
	if inst.State.Name != ec2types.InstanceStateNameRunning {
		return fmt.Sprintf("*%s* is not running (state: %s). Start it first with `/prism start %s`.",
			reg.Nickname, inst.State.Name, reg.Nickname), nil
	}
	if inst.PublicIpAddress != nil {
		return fmt.Sprintf("🔗 *%s*: http://%s", reg.Nickname, *inst.PublicIpAddress), nil
	}
	return fmt.Sprintf("*%s* has no public IP or DNS name configured.", reg.Nickname), nil
}

// platformConnectTTL returns the platform-level default connect code TTL.
// Set BOT_CONNECT_CODE_TTL_HOURS to override; default is 24h.
func platformConnectTTL() time.Duration {
	if h := getEnv("BOT_CONNECT_CODE_TTL_HOURS", ""); h != "" {
		if n, err := time.ParseDuration(h + "h"); err == nil {
			return n
		}
	}
	return 24 * time.Hour
}

// cmdConnect generates a connect code for self-registration.
// Usage: /spore connect [duration]   e.g. /spore connect 4h
// Duration cannot exceed the workspace or platform maximum.
// The user shares SPORE-XXXXXX with their Instance Owner, who runs:
//
//	spawn bot register --connect-code SPORE-XXXXXX --instance i-... --nickname ...
func cmdConnect(ctx context.Context, reg *Registry, action *BotAction) (string, error) {
	platformMax := platformConnectTTL()

	// Look up workspace TTL cap (workspace admin can only lower, not raise)
	ws, err := reg.GetWorkspace(ctx, action.Platform, action.WorkspaceID)
	workspaceMax := platformMax
	if err == nil && ws.ConnectCodeTTLHours > 0 {
		wsTTL := time.Duration(ws.ConnectCodeTTLHours) * time.Hour
		if wsTTL < workspaceMax {
			workspaceMax = wsTTL
		}
	}

	// User-requested duration (optional: /spore connect 4h)
	ttl := workspaceMax
	if action.Nickname != "" {
		requested, err := time.ParseDuration(action.Nickname)
		if err != nil {
			return fmt.Sprintf("❌ Invalid duration `%s`. Use a format like `4h`, `30m`, or `24h`.", action.Nickname), nil
		}
		if requested > workspaceMax {
			return fmt.Sprintf("❌ Requested duration `%s` exceeds the workspace maximum of `%s`. Use a shorter value.",
				action.Nickname, formatDuration(workspaceMax)), nil
		}
		ttl = requested
	}

	// Generate a human-friendly 6-character uppercase hex code
	code := strings.ToUpper(fmt.Sprintf("%06x", time.Now().UnixNano()%0xFFFFFF))

	cc := ConnectCode{
		CodeKey:     "connect#" + code,
		Platform:    action.Platform,
		WorkspaceID: action.WorkspaceID,
		UserID:      action.UserID,
		TTL:         time.Now().Add(ttl).Unix(),
	}
	if err := reg.PutConnectCode(ctx, cc); err != nil {
		return "", fmt.Errorf("generate connect code: %w", err)
	}

	expiryDesc := formatDuration(ttl)
	return fmt.Sprintf("🔑 *Your connect code:* `SPORE-%s`\n\n"+
		"Share this with your workspace admin and ask them to run:\n"+
		"```\nspawn bot register \\\n"+
		"  --connect-code SPORE-%s \\\n"+
		"  --instance <instance-id-or-name> \\\n"+
		"  --nickname <friendly-name>\n```\n"+
		"_Code expires in %s and can only be used once._",
		code, code, expiryDesc), nil
}

func helpText(slashCmd string) string {
	c := slashCmd
	if c == "" {
		c = "/prism"
	}
	return fmt.Sprintf(`*Available commands:*
• *%s status [name]* — instance state, IP, and URL
• *%s start [name]* — start a stopped instance
• *%s stop [name]* — stop a running instance
• *%s hibernate [name]* — hibernate (saves RAM, pauses compute billing)
• *%s url [name]* — get the instance URL
• *%s list* — show your instances and notification subscriptions
• *%s notify <name>* — subscribe to DM notifications for an instance
• *%s unnotify <name>* — stop DM notifications for an instance
• *%s connect [duration]* — get a one-time code to share with your workspace admin
• *%s help* — this message

_[name] is optional if you have only one instance. Use the nickname, instance ID, or DNS name._`,
		c, c, c, c, c, c, c, c, c, c)
}

func postResponse(platform, responseURL, text string) error {
	switch platform {
	case "slack":
		return postSlackResponse(responseURL, text, false)
	case "teams":
		return postTeamsResponse(responseURL, text)
	default:
		return fmt.Errorf("unknown platform: %s", platform)
	}
}
