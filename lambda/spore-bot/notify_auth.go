package main

import (
	"regexp"
	"strings"
	"unicode"

	"github.com/aws/aws-lambda-go/events"
	dynamodbtypes "github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
)

// Authentication of POST /notify (#702).
//
// /notify used to authenticate nobody: #374 removed the log-only PKCS#7 check,
// and the registry-membership gate below it is authorization on ids, not
// authentication of the sender. Anyone who knew a workspace ID could post
// attacker-written text into its channel webhook, and anyone who also knew a
// registered instance ID could DM or SMS its users.
//
// Now a notification must arrive SigV4-signed, through an AWS_IAM Function URL
// (infra/tofu/spore-bot, aws_lambda_function_url.notify) or an IAM-authorized
// API Gateway method, so Lambda itself verified the signature and filled in
// the caller below. The caller must be EC2 instance-profile credentials for the
// instance the request names: an assumed-role session whose name is
// instance_id, as EC2 issues them. The registry then binds the instance to an
// account (notifyRegistrationCheck), so a session merely named after someone
// else's instance, from another account, reaches nobody's DMs or SMS.
//
// A request through the NONE-auth Function URL (the one Slack, Teams and
// Discord use) carries no IAM authorizer, so it is refused.

// notifyCaller is the SigV4-verified identity Lambda attached to a request.
type notifyCaller struct {
	AccountID string
	ARN       string
}

// callerFromFunctionURL returns the IAM identity of a Function URL request,
// present only when the URL's AuthType is AWS_IAM.
func callerFromFunctionURL(r events.LambdaFunctionURLRequest) *notifyCaller {
	a := r.RequestContext.Authorizer
	if a == nil || a.IAM == nil || a.IAM.UserARN == "" {
		return nil
	}
	return &notifyCaller{AccountID: a.IAM.AccountID, ARN: a.IAM.UserARN}
}

// callerFromAPIGateway returns the IAM identity of an API Gateway (v1) proxy
// request, present only when the method's authorization is AWS_IAM.
func callerFromAPIGateway(r events.APIGatewayProxyRequest) *notifyCaller {
	id := r.RequestContext.Identity
	if id.UserArn == "" {
		return nil
	}
	return &notifyCaller{AccountID: id.AccountID, ARN: id.UserArn}
}

// instanceSessionRE matches EC2 instance-profile credentials:
// arn:aws:sts::<account>:assumed-role/<role>/<instance-id>.
var instanceSessionRE = regexp.MustCompile(`^arn:aws[a-z-]*:sts::([0-9]{12}):assumed-role/[\w+=,.@-]{1,64}/(i-[0-9a-f]{8,17})$`)

// authorizeNotifier checks that caller is the instance instanceID's own
// credentials. It returns the HTTP status and message to refuse with, or
// ok=true.
func authorizeNotifier(caller *notifyCaller, instanceID string) (status int, msg string, ok bool) {
	if caller == nil {
		return 401, "notify requires a SigV4-signed request from the instance's role", false
	}
	m := instanceSessionRE.FindStringSubmatch(caller.ARN)
	if m == nil || m[1] != caller.AccountID {
		return 403, "caller is not an EC2 instance role session", false
	}
	if m[2] != instanceID {
		return 403, "instance_id is not the calling instance", false
	}
	return 0, "", true
}

// iamRoleAccountRE extracts the account of a registration's role ARN.
var iamRoleAccountRE = regexp.MustCompile(`^arn:aws[a-z-]*:iam::([0-9]{12}):role/`)

// registrationAccount is the AWS account a registration item places its
// instance in: aws_account_id, else the account of role_arn (the role the bot
// assumes to act on the instance, which lives in the instance's account). ""
// if neither says.
func registrationAccount(item map[string]dynamodbtypes.AttributeValue) string {
	if v, ok := item["aws_account_id"].(*dynamodbtypes.AttributeValueMemberS); ok && v.Value != "" {
		return v.Value
	}
	if v, ok := item["role_arn"].(*dynamodbtypes.AttributeValueMemberS); ok {
		if m := iamRoleAccountRE.FindStringSubmatch(v.Value); m != nil {
			return m[1]
		}
	}
	return ""
}

// instanceRegistration is what the registry says about the instance a
// notification is delivered for, relative to the verified caller's account.
type instanceRegistration struct {
	// Registered: the instance has a registration in the target workspace, and
	// some registration of it places it in the caller's account. This gates the
	// per-user DMs and SMS.
	Registered bool
	// ForeignAccount: the instance's registrations place it in other accounts
	// only. The caller is not that instance, whatever its session is called, so
	// the notification is refused outright.
	ForeignAccount bool
}

// notifyRegistrationCheck evaluates the instance_id-index items for one
// instance. A registration whose account is unknown (a notify-only
// subscription) counts toward "in the workspace" but binds no account, so an
// instance registered only that way gets no DMs or SMS: fail closed.
func notifyRegistrationCheck(items []map[string]dynamodbtypes.AttributeValue, platform, workspaceID, callerAccount string) instanceRegistration {
	prefix := platform + "#" + workspaceID + "#"
	inWorkspace, match, other := false, false, false
	for _, item := range items {
		if uk, ok := item["user_key"].(*dynamodbtypes.AttributeValueMemberS); ok && strings.HasPrefix(uk.Value, prefix) {
			inWorkspace = true
		}
		switch acct := registrationAccount(item); {
		case acct == "":
		case acct == callerAccount:
			match = true
		default:
			other = true
		}
	}
	return instanceRegistration{
		Registered:     inWorkspace && match,
		ForeignAccount: other && !match,
	}
}

// Limits on the request's free-text fields. A notification is a sentence and,
// for detailEvents, an error or output tail; nothing needs more.
const (
	maxNotifyName   = 128
	maxNotifyDetail = 1500
)

var (
	dnsNameRE = regexp.MustCompile(`^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$`)
	regionRE  = regexp.MustCompile(`^[a-z]{2}(-[a-z]+)+-[0-9]$`)
)

// sanitizeNotify bounds the request's caller-written fields before any
// platform sees them: control characters removed (newlines kept only in
// Detail), lengths capped, DNSName and Region dropped unless well-formed, and
// code fences removed so Detail cannot close its own code block. Slack's
// escaping of &, < and > is formatNotification's (slackEscape), since SMS and
// Discord render text differently.
func sanitizeNotify(nr NotifyRequest) NotifyRequest {
	nr.InstanceName = clip(stripControl(nr.InstanceName, false), maxNotifyName)
	nr.Detail = clip(strings.ReplaceAll(stripControl(nr.Detail, true), "```", "'''"), maxNotifyDetail)
	nr.EventType = clip(stripControl(nr.EventType, false), 64)
	if !dnsNameRE.MatchString(strings.ToLower(nr.DNSName)) || len(nr.DNSName) > 253 {
		nr.DNSName = ""
	}
	if !regionRE.MatchString(nr.Region) {
		nr.Region = ""
	}
	if nr.OriginalInstanceID != "" && !instanceIDRE.MatchString(nr.OriginalInstanceID) {
		nr.OriginalInstanceID = ""
	}
	return nr
}

func stripControl(s string, keepNewlines bool) string {
	return strings.Map(func(r rune) rune {
		if r == '\n' && keepNewlines {
			return r
		}
		if unicode.IsControl(r) || unicode.Is(unicode.Cf, r) {
			return -1
		}
		return r
	}, s)
}

func clip(s string, n int) string {
	if r := []rune(s); len(r) > n {
		return string(r[:n-1]) + "…"
	}
	return s
}

// slackEscape escapes the three characters Slack's mrkdwn gives meaning to in
// <...> sequences (links, mentions such as <!channel>), as Slack documents.
var slackEscaper = strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;")

func slackEscape(s string) string { return slackEscaper.Replace(s) }
