package cmd

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"text/tabwriter"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/feature/dynamodb/attributevalue"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	dynamodbtypes "github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
	"github.com/aws/aws-sdk-go-v2/service/sts"
	"github.com/scttfrdmn/spore-host/spawn/pkg/tagprefix"
	"github.com/spf13/cobra"
)

const defaultBotRegistryTable = "spore-bot-registry"

var (
	botPlatform    string
	botUser        string
	botUserID      string
	botWorkspaceID string
	botInstance    string
	botNickname    string
	botAllow       []string
	botTagPrefix   string
	botTable       string
	botJSONOutput  bool
	botRoleARN     string
)

var botCmd = &cobra.Command{
	Use:   "bot",
	Short: "Manage chat bot registrations for instance control",
	Long: `Register and manage Slack/Teams bot access to instances.

The bot lets authorized chat users start, stop, hibernate, and check
status on instances without CLI access.

Examples:
  spawn bot register --platform slack --user professor@example.com \
    --instance i-0abc123 --nickname rstudio --allow start,stop,status
  spawn bot deregister --platform slack --user professor@example.com --nickname rstudio
  spawn bot list --platform slack --workspace T03NE3GTY`,
}

// ── register ─────────────────────────────────────────────────────────────────

var botRegisterCmd = &cobra.Command{
	Use:   "register",
	Short: "Register an instance for chat bot control",
	Long: `Register an EC2 instance so a chat user can control it via slash commands.

Supports specifying the user by email (--user) which resolves to a platform
user ID, or directly by platform ID (--user-id + --workspace-id).

The --nickname is the friendly name used in slash commands, e.g.:
  /prism stop rstudio
  /prism status jupyter

Both the instance ID and instance name (DNS name or spawn:name tag) are
accepted as the target in slash commands once registered.`,
	RunE: runBotRegister,
}

func runBotRegister(cmd *cobra.Command, args []string) error {
	if botPlatform == "" {
		return fmt.Errorf("--platform is required (slack or teams)")
	}
	if botInstance == "" {
		return fmt.Errorf("--instance is required")
	}
	if botNickname == "" {
		botNickname = "default"
	}
	if len(botAllow) == 0 {
		botAllow = []string{"start", "stop", "status", "hibernate", "url"}
	}

	// Resolve tag prefix: flag > env > "spawn"
	tagpfx := botTagPrefix
	if tagpfx == "" {
		tagprefix.Init()
		tagpfx = tagprefix.Prefix()
	}

	ctx := context.Background()
	cfg, err := awsconfig.LoadDefaultConfig(ctx)
	if err != nil {
		return fmt.Errorf("load AWS config: %w", err)
	}

	// Resolve user ID if email provided
	userID := botUserID
	workspaceID := botWorkspaceID
	if userID == "" {
		if botUser == "" {
			return fmt.Errorf("either --user (email) or --user-id must be provided")
		}
		// For now, require --user-id unless email resolution is implemented
		// Email → user ID requires a Slack API call with the bot token
		return fmt.Errorf("email resolution not yet implemented; use --user-id and --workspace-id directly")
	}

	// Get caller identity for registered_by
	stsClient := sts.NewFromConfig(cfg)
	identity, err := stsClient.GetCallerIdentity(ctx, nil)
	if err != nil {
		return fmt.Errorf("get caller identity: %w", err)
	}
	registeredBy := *identity.Arn

	// Build registry key
	userKey := strings.Join([]string{botPlatform, workspaceID, userID}, "#")

	reg := botRegistration{
		UserKey:        userKey,
		Nickname:       botNickname,
		InstanceID:     botInstance,
		AWSAccountID:   *identity.Account,
		RoleARN:        botRoleARN,
		TagPrefix:      tagpfx,
		AllowedActions: botAllow,
		RegisteredBy:   registeredBy,
		Platform:       botPlatform,
		CreatedAt:      time.Now().UTC().Format(time.RFC3339),
	}

	tableName := botTable
	if tableName == "" {
		tableName = defaultBotRegistryTable
	}

	client := dynamodb.NewFromConfig(cfg)
	item, err := attributevalue.MarshalMap(reg)
	if err != nil {
		return fmt.Errorf("marshal registration: %w", err)
	}
	_, err = client.PutItem(ctx, &dynamodb.PutItemInput{
		TableName: aws.String(tableName),
		Item:      item,
	})
	if err != nil {
		return fmt.Errorf("write registration: %w", err)
	}

	if botJSONOutput {
		return json.NewEncoder(os.Stdout).Encode(reg)
	}
	fmt.Printf("Registered: %s → %s for %s/%s in %s/%s\n",
		reg.Nickname, reg.InstanceID, botPlatform, userID, botPlatform, workspaceID)
	fmt.Printf("  Allowed actions: %s\n", strings.Join(reg.AllowedActions, ", "))
	fmt.Printf("  Tag prefix: %s\n", reg.TagPrefix)
	return nil
}

// ── deregister ────────────────────────────────────────────────────────────────

var botDeregisterCmd = &cobra.Command{
	Use:   "deregister",
	Short: "Remove a chat bot registration",
	RunE: func(cmd *cobra.Command, args []string) error {
		if botPlatform == "" || botUserID == "" || botWorkspaceID == "" || botNickname == "" {
			return fmt.Errorf("--platform, --user-id, --workspace-id, and --nickname are all required")
		}
		ctx := context.Background()
		cfg, err := awsconfig.LoadDefaultConfig(ctx)
		if err != nil {
			return fmt.Errorf("load AWS config: %w", err)
		}
		tableName := botTable
		if tableName == "" {
			tableName = defaultBotRegistryTable
		}
		userKey := strings.Join([]string{botPlatform, botWorkspaceID, botUserID}, "#")
		client := dynamodb.NewFromConfig(cfg)
		_, err = client.DeleteItem(ctx, &dynamodb.DeleteItemInput{
			TableName: aws.String(tableName),
			Key: map[string]dynamodbtypes.AttributeValue{
				"user_key": &dynamodbtypes.AttributeValueMemberS{Value: userKey},
				"nickname": &dynamodbtypes.AttributeValueMemberS{Value: botNickname},
			},
		})
		if err != nil {
			return fmt.Errorf("delete registration: %w", err)
		}
		fmt.Printf("Deregistered: %s/%s/%s (%s)\n", botPlatform, botWorkspaceID, botUserID, botNickname)
		return nil
	},
}

// ── list ──────────────────────────────────────────────────────────────────────

var botListCmd = &cobra.Command{
	Use:   "list",
	Short: "List chat bot registrations for a workspace",
	RunE: func(cmd *cobra.Command, args []string) error {
		if botPlatform == "" || botWorkspaceID == "" {
			return fmt.Errorf("--platform and --workspace-id are required")
		}
		ctx := context.Background()
		cfg, err := awsconfig.LoadDefaultConfig(ctx)
		if err != nil {
			return fmt.Errorf("load AWS config: %w", err)
		}
		tableName := botTable
		if tableName == "" {
			tableName = defaultBotRegistryTable
		}
		// Scan with filter on platform+workspace prefix
		client := dynamodb.NewFromConfig(cfg)
		prefix := botPlatform + "#" + botWorkspaceID + "#"
		result, err := client.Scan(ctx, &dynamodb.ScanInput{
			TableName:        aws.String(tableName),
			FilterExpression: aws.String("begins_with(user_key, :prefix)"),
			ExpressionAttributeValues: map[string]dynamodbtypes.AttributeValue{
				":prefix": &dynamodbtypes.AttributeValueMemberS{Value: prefix},
			},
		})
		if err != nil {
			return fmt.Errorf("scan registrations: %w", err)
		}
		if botJSONOutput {
			var regs []botRegistration
			for _, item := range result.Items {
				var r botRegistration
				if err := attributevalue.UnmarshalMap(item, &r); err == nil {
					regs = append(regs, r)
				}
			}
			return json.NewEncoder(os.Stdout).Encode(regs)
		}
		if len(result.Items) == 0 {
			fmt.Println("No registrations found.")
			return nil
		}
		w := tabwriter.NewWriter(os.Stdout, 0, 0, 2, ' ', 0)
		fmt.Fprintln(w, "USER\tNICKNAME\tINSTANCE\tACTIONS\tTAG PREFIX")
		for _, item := range result.Items {
			var r botRegistration
			if err := attributevalue.UnmarshalMap(item, &r); err != nil {
				continue
			}
			parts := strings.SplitN(r.UserKey, "#", 3)
			userID := ""
			if len(parts) == 3 {
				userID = parts[2]
			}
			fmt.Fprintf(w, "%s\t%s\t%s\t%s\t%s\n",
				userID, r.Nickname, r.InstanceID,
				strings.Join(r.AllowedActions, ","), r.TagPrefix)
		}
		return w.Flush()
	},
}

// ── workspace-add / workspace-remove / workspace-list ────────────────────────

const defaultBotWorkspacesTable = "spore-bot-workspaces"

var (
	botWorkspaceName   string
	botBotToken        string
	botSigningSecret   string
	botWorkspacesTable string
)

type botWorkspace struct {
	WorkspaceKey  string `dynamodbav:"workspace_key" json:"workspace_key"`
	BotToken      string `dynamodbav:"bot_token" json:"bot_token"`
	SigningSecret string `dynamodbav:"signing_secret" json:"signing_secret"`
	Platform      string `dynamodbav:"platform" json:"platform"`
	WorkspaceName string `dynamodbav:"workspace_name,omitempty" json:"workspace_name,omitempty"`
	InstalledBy   string `dynamodbav:"installed_by" json:"installed_by"`
	InstalledAt   string `dynamodbav:"installed_at" json:"installed_at"`
}

var botWorkspaceAddCmd = &cobra.Command{
	Use:   "workspace-add",
	Short: "Register a Slack/Teams workspace's bot token and signing secret",
	Long: `Store the Slack bot token and signing secret for a workspace so the
prism-bot Lambda can verify incoming slash command requests.

Run this once after installing the Slack app in a workspace:

  spawn bot workspace-add \
    --platform slack \
    --workspace-id T03NE3GTY \
    --workspace-name "My Workspace" \
    --bot-token xoxb-... \
    --signing-secret abc123...`,
	RunE: func(cmd *cobra.Command, args []string) error {
		if botPlatform == "" || botWorkspaceID == "" {
			return fmt.Errorf("--platform and --workspace-id are required")
		}
		if botSigningSecret == "" {
			return fmt.Errorf("--signing-secret is required")
		}
		ctx := context.Background()
		cfg, err := awsconfig.LoadDefaultConfig(ctx)
		if err != nil {
			return fmt.Errorf("load AWS config: %w", err)
		}
		stsClient := sts.NewFromConfig(cfg)
		identity, err := stsClient.GetCallerIdentity(ctx, nil)
		if err != nil {
			return fmt.Errorf("get caller identity: %w", err)
		}
		ws := botWorkspace{
			WorkspaceKey:  botPlatform + "#" + botWorkspaceID,
			BotToken:      botBotToken,
			SigningSecret: botSigningSecret,
			Platform:      botPlatform,
			WorkspaceName: botWorkspaceName,
			InstalledBy:   *identity.Arn,
			InstalledAt:   time.Now().UTC().Format(time.RFC3339),
		}
		tableName := botWorkspacesTable
		if tableName == "" {
			tableName = defaultBotWorkspacesTable
		}
		client := dynamodb.NewFromConfig(cfg)
		item, err := attributevalue.MarshalMap(ws)
		if err != nil {
			return fmt.Errorf("marshal workspace: %w", err)
		}
		_, err = client.PutItem(ctx, &dynamodb.PutItemInput{
			TableName: aws.String(tableName),
			Item:      item,
		})
		if err != nil {
			return fmt.Errorf("write workspace: %w", err)
		}
		if botJSONOutput {
			return json.NewEncoder(os.Stdout).Encode(ws)
		}
		fmt.Printf("Registered workspace: %s/%s", botPlatform, botWorkspaceID)
		if botWorkspaceName != "" {
			fmt.Printf(" (%s)", botWorkspaceName)
		}
		fmt.Println()
		return nil
	},
}

var botWorkspaceRemoveCmd = &cobra.Command{
	Use:   "workspace-remove",
	Short: "Remove a workspace registration",
	RunE: func(cmd *cobra.Command, args []string) error {
		if botPlatform == "" || botWorkspaceID == "" {
			return fmt.Errorf("--platform and --workspace-id are required")
		}
		ctx := context.Background()
		cfg, err := awsconfig.LoadDefaultConfig(ctx)
		if err != nil {
			return fmt.Errorf("load AWS config: %w", err)
		}
		tableName := botWorkspacesTable
		if tableName == "" {
			tableName = defaultBotWorkspacesTable
		}
		client := dynamodb.NewFromConfig(cfg)
		_, err = client.DeleteItem(ctx, &dynamodb.DeleteItemInput{
			TableName: aws.String(tableName),
			Key: map[string]dynamodbtypes.AttributeValue{
				"workspace_key": &dynamodbtypes.AttributeValueMemberS{Value: botPlatform + "#" + botWorkspaceID},
			},
		})
		if err != nil {
			return fmt.Errorf("delete workspace: %w", err)
		}
		fmt.Printf("Removed workspace: %s/%s\n", botPlatform, botWorkspaceID)
		return nil
	},
}

var botWorkspaceListCmd = &cobra.Command{
	Use:   "workspace-list",
	Short: "List registered workspaces",
	RunE: func(cmd *cobra.Command, args []string) error {
		ctx := context.Background()
		cfg, err := awsconfig.LoadDefaultConfig(ctx)
		if err != nil {
			return fmt.Errorf("load AWS config: %w", err)
		}
		tableName := botWorkspacesTable
		if tableName == "" {
			tableName = defaultBotWorkspacesTable
		}
		client := dynamodb.NewFromConfig(cfg)
		input := &dynamodb.ScanInput{TableName: aws.String(tableName)}
		if botPlatform != "" {
			input.FilterExpression = aws.String("platform = :p")
			input.ExpressionAttributeValues = map[string]dynamodbtypes.AttributeValue{
				":p": &dynamodbtypes.AttributeValueMemberS{Value: botPlatform},
			}
		}
		result, err := client.Scan(ctx, input)
		if err != nil {
			return fmt.Errorf("scan workspaces: %w", err)
		}
		if botJSONOutput {
			var wss []botWorkspace
			for _, item := range result.Items {
				var ws botWorkspace
				if err := attributevalue.UnmarshalMap(item, &ws); err == nil {
					ws.BotToken = "(redacted)"
					ws.SigningSecret = "(redacted)"
					wss = append(wss, ws)
				}
			}
			return json.NewEncoder(os.Stdout).Encode(wss)
		}
		if len(result.Items) == 0 {
			fmt.Println("No workspaces registered.")
			return nil
		}
		w := tabwriter.NewWriter(os.Stdout, 0, 0, 2, ' ', 0)
		fmt.Fprintln(w, "PLATFORM\tWORKSPACE ID\tNAME\tINSTALLED BY\tINSTALLED AT")
		for _, item := range result.Items {
			var ws botWorkspace
			if err := attributevalue.UnmarshalMap(item, &ws); err != nil {
				continue
			}
			parts := strings.SplitN(ws.WorkspaceKey, "#", 2)
			wsID := ""
			if len(parts) == 2 {
				wsID = parts[1]
			}
			fmt.Fprintf(w, "%s\t%s\t%s\t%s\t%s\n",
				ws.Platform, wsID, ws.WorkspaceName, ws.InstalledBy, ws.InstalledAt)
		}
		return w.Flush()
	},
}

// ── types ────────────────────────────────────────────────────────────────────

type botRegistration struct {
	UserKey        string   `dynamodbav:"user_key" json:"user_key"`
	Nickname       string   `dynamodbav:"nickname" json:"nickname"`
	InstanceID     string   `dynamodbav:"instance_id" json:"instance_id"`
	AWSAccountID   string   `dynamodbav:"aws_account_id" json:"aws_account_id"`
	RoleARN        string   `dynamodbav:"role_arn,omitempty" json:"role_arn,omitempty"`
	DNSName        string   `dynamodbav:"dns_name,omitempty" json:"dns_name,omitempty"`
	TagPrefix      string   `dynamodbav:"tag_prefix" json:"tag_prefix"`
	AllowedActions []string `dynamodbav:"allowed_actions" json:"allowed_actions"`
	RegisteredBy   string   `dynamodbav:"registered_by" json:"registered_by"`
	Platform       string   `dynamodbav:"platform" json:"platform"`
	CreatedAt      string   `dynamodbav:"created_at" json:"created_at"`
}

// ── init ─────────────────────────────────────────────────────────────────────

func init() {
	rootCmd.AddCommand(botCmd)
	botCmd.AddCommand(botRegisterCmd, botDeregisterCmd, botListCmd,
		botWorkspaceAddCmd, botWorkspaceRemoveCmd, botWorkspaceListCmd)

	// Shared flags across all subcommands
	allSubs := []*cobra.Command{
		botRegisterCmd, botDeregisterCmd, botListCmd,
		botWorkspaceAddCmd, botWorkspaceRemoveCmd, botWorkspaceListCmd,
	}
	for _, sub := range allSubs {
		sub.Flags().StringVar(&botPlatform, "platform", "", "Chat platform: slack or teams")
		sub.Flags().BoolVar(&botJSONOutput, "json", false, "Output as JSON")
	}

	// Registry table override (register/deregister/list)
	for _, sub := range []*cobra.Command{botRegisterCmd, botDeregisterCmd, botListCmd} {
		sub.Flags().StringVar(&botTable, "table", "", "Override DynamoDB registry table name")
	}

	// Workspaces table override + workspace-id for workspace commands
	for _, sub := range []*cobra.Command{botWorkspaceAddCmd, botWorkspaceRemoveCmd, botWorkspaceListCmd} {
		sub.Flags().StringVar(&botWorkspacesTable, "table", "", "Override DynamoDB workspaces table name")
	}
	botWorkspaceAddCmd.Flags().StringVar(&botWorkspaceName, "workspace-name", "", "Human-friendly workspace name")
	botWorkspaceAddCmd.Flags().StringVar(&botBotToken, "bot-token", "", "Slack bot token (xoxb-...)")
	botWorkspaceAddCmd.Flags().StringVar(&botSigningSecret, "signing-secret", "", "Slack signing secret (required)")

	// Register-specific flags
	botRegisterCmd.Flags().StringVar(&botUser, "user", "", "User email address (resolved to platform user ID)")
	botRegisterCmd.Flags().StringVar(&botUserID, "user-id", "", "Platform-native user ID (e.g. Slack U04KZABCD)")
	botRegisterCmd.Flags().StringVar(&botWorkspaceID, "workspace-id", "", "Platform workspace ID (e.g. Slack T03NE3GTY)")
	botRegisterCmd.Flags().StringVar(&botInstance, "instance", "", "Instance ID (i-...) or name")
	botRegisterCmd.Flags().StringVar(&botNickname, "nickname", "", "Friendly name for slash commands (default: 'default')")
	botRegisterCmd.Flags().StringSliceVar(&botAllow, "allow", nil, "Allowed actions (default: start,stop,status,hibernate,url)")
	botRegisterCmd.Flags().StringVar(&botTagPrefix, "tag-prefix", "", "Tag prefix: spawn or prism (default: auto-detected)")
	botRegisterCmd.Flags().StringVar(&botRoleARN, "role-arn", "", "Cross-account IAM role ARN for this instance's account")

	// Deregister flags
	botDeregisterCmd.Flags().StringVar(&botUserID, "user-id", "", "Platform user ID")
	botDeregisterCmd.Flags().StringVar(&botWorkspaceID, "workspace-id", "", "Platform workspace ID")
	botDeregisterCmd.Flags().StringVar(&botNickname, "nickname", "", "Nickname to deregister")

	// List flags
	botListCmd.Flags().StringVar(&botWorkspaceID, "workspace-id", "", "Platform workspace ID")

	// workspace-add/remove share workspace-id
	botWorkspaceAddCmd.Flags().StringVar(&botWorkspaceID, "workspace-id", "", "Platform workspace ID")
	botWorkspaceRemoveCmd.Flags().StringVar(&botWorkspaceID, "workspace-id", "", "Platform workspace ID")
}
