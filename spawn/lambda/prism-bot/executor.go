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
	Platform     string           `json:"platform"`
	WorkspaceID  string           `json:"workspace_id"`
	UserID       string           `json:"user_id"`
	ResponseURL  string           `json:"response_url"`
	Command      string           `json:"command"`  // "status","start","stop","hibernate","url","list","help"
	Nickname     string           `json:"nickname"` // may be empty (single-instance case)
	Registration *BotRegistration `json:"registration"`
}

// executeAction runs the EC2 operation and posts the result back to the chat platform.
func executeAction(ctx context.Context, cfg aws.Config, reg *Registry, action *BotAction) {
	var result string
	var err error

	switch action.Command {
	case "list":
		result, err = cmdList(ctx, reg, action)
	case "help":
		result = helpText()
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
	}

	if err != nil {
		result = fmt.Sprintf("❌ Error: %s", err.Error())
	}

	// Post result back to the chat platform
	if err := postResponse(action.Platform, action.ResponseURL, result); err != nil {
		logf("failed to post response: %v", err)
	}
}

// resolveRegistration finds the right registration, prompting if ambiguous.
// Supports nickname, instance ID ("i-..."), or instance name (DNS name / tag).
func resolveRegistration(ctx context.Context, reg *Registry, action *BotAction) (*BotRegistration, string, error) {
	regs, err := reg.ListUserInstances(ctx, action.Platform, action.WorkspaceID, action.UserID)
	if err != nil {
		return nil, "", err
	}
	if len(regs) == 0 {
		return nil, "", fmt.Errorf("no instances registered. Run `spawn bot register` to register one")
	}

	// No nickname given
	if action.Nickname == "" {
		if len(regs) == 1 {
			return &regs[0], "", nil
		}
		names := make([]string, len(regs))
		for i, r := range regs {
			names[i] = r.Nickname
		}
		return nil, fmt.Sprintf("You have multiple instances: %s\nUse `/%s %s <nickname>` to specify one.",
			strings.Join(names, ", "), action.Platform, action.Command), nil
	}

	// Match by nickname first
	for i := range regs {
		if strings.EqualFold(regs[i].Nickname, action.Nickname) {
			return &regs[i], "", nil
		}
	}

	// Match by instance ID or instance name (DNS name)
	for i := range regs {
		if strings.EqualFold(regs[i].InstanceID, action.Nickname) {
			return &regs[i], "", nil
		}
		if strings.EqualFold(regs[i].DNSName, action.Nickname) {
			return &regs[i], "", nil
		}
	}

	return nil, fmt.Sprintf("No instance named `%s`. Your instances: %s",
		action.Nickname, registrationNames(regs)), nil
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
		o.RoleSessionName = "prism-bot-" + instanceID
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
	// Prefer instance name tag over nickname for display
	displayName := reg.Nickname
	for _, tag := range inst.Tags {
		if tag.Key != nil && *tag.Key == reg.TagPrefix+":name" && tag.Value != nil {
			displayName = *tag.Value
			break
		}
	}
	return formatSlackStatus(displayName, reg.InstanceID, state, ip, reg.DNSName), nil
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

func helpText() string {
	return `*Available commands:*
• */prism status [name]* — instance state, IP, and URL
• */prism start [name]* — start a stopped instance
• */prism stop [name]* — stop a running instance
• */prism hibernate [name]* — hibernate (saves RAM, pauses compute billing)
• */prism url [name]* — get the instance URL
• */prism list* — show all your registered instances
• */prism help* — this message

_[name] is optional if you have only one instance. Use the nickname, instance ID, or DNS name._`
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
