package main

import (
	"context"
	"fmt"
	"strings"

	"github.com/aws/aws-sdk-go-v2/aws"
	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/credentials/stscreds"
	"github.com/aws/aws-sdk-go-v2/service/ec2"
	ec2types "github.com/aws/aws-sdk-go-v2/service/ec2/types"
	"github.com/aws/aws-sdk-go-v2/service/sts"
)

// BotAction is the payload passed from Phase 1 (ACK) to Phase 2 (execute).
type BotAction struct {
	Platform      string           `json:"platform"`
	WorkspaceID   string           `json:"workspace_id"`
	UserID        string           `json:"user_id"`
	ResponseURL   string           `json:"response_url"`
	Command       string           `json:"command"`       // "status","start","stop","hibernate","url","list","help"
	Nickname      string           `json:"nickname"`      // may be empty (single-instance case)
	SlashCommand  string           `json:"slash_command"` // e.g. "/spore" or "/prism" — from Slack payload
	Registration  *BotRegistration `json:"registration"`
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
	case "list":
		result, err = cmdList(ctx, reg, action)
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
		return "No instances registered. Run `spawn bot register` to register one.", nil
	}
	lines := []string{"*Your registered instances:*"}
	for _, r := range regs {
		line := fmt.Sprintf("• *%s* — `%s`", r.Nickname, r.InstanceID)
		if r.DNSName != "" {
			line += fmt.Sprintf(" (%s)", r.DNSName)
		}
		line += fmt.Sprintf(" [%s]", strings.Join(r.AllowedActions, ", "))
		lines = append(lines, line)
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
	ip := ""
	if inst.PublicIpAddress != nil {
		ip = *inst.PublicIpAddress
	}

	// Collect useful tags: display name, DNS name, account base36
	displayName := reg.Nickname
	dnsShort := ""    // e.g. "spore-bot-test"
	accountBase36 := "" // e.g. "5k0zfnmq"
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
		}
	}

	// Construct full DNS name: {name}.{account-base36}.spore.host
	dnsName := reg.DNSName
	if dnsName == "" && dnsShort != "" && accountBase36 != "" {
		dnsName = dnsShort + "." + accountBase36 + ".spore.host"
	}

	return formatSlackStatus(displayName, reg.InstanceID, state, ip, dnsName), nil
}

func startInstance(ctx context.Context, client *ec2.Client, reg *BotRegistration) (string, error) {
	_, err := client.StartInstances(ctx, &ec2.StartInstancesInput{
		InstanceIds: []string{reg.InstanceID},
	})
	if err != nil {
		return "", fmt.Errorf("start instance: %w", err)
	}
	msg := fmt.Sprintf("▶️ Starting *%s* (`%s`)...", reg.Nickname, reg.InstanceID)
	if reg.DNSName != "" {
		msg += fmt.Sprintf("\nWill be available at: https://%s", reg.DNSName)
	}
	return msg, nil
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
• *%s list* — show all your registered instances
• *%s help* — this message

_[name] is optional if you have only one instance. Use the nickname, instance ID, or DNS name._`,
		c, c, c, c, c, c, c)
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
