package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/aws/aws-lambda-go/events"
	"github.com/aws/aws-lambda-go/lambda"
	"github.com/aws/aws-sdk-go-v2/aws"
	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	lambdasvc "github.com/aws/aws-sdk-go-v2/service/lambda"
	lambdatypes "github.com/aws/aws-sdk-go-v2/service/lambda/types"
)

var (
	cfg          aws.Config
	reg          *Registry
	auditor      *Auditor
	lambdaClient *lambdasvc.Client
	functionName string
	// discordPublicKey is the spore-bot Discord application's Ed25519 public key
	// (hex), used to verify all inbound Discord interactions. One per application
	// (#2). Set via the DISCORD_PUBLIC_KEY env var.
	discordPublicKey string
	httpClient       = &http.Client{Timeout: 15 * time.Second}
)

func init() {
	ctx := context.Background()
	var err error
	cfg, err = awsconfig.LoadDefaultConfig(ctx)
	if err != nil {
		log.Fatalf("load config: %v", err)
	}
	reg = newRegistry(cfg)
	auditor = NewAuditor(cfg)
	lambdaClient = lambdasvc.NewFromConfig(cfg)
	functionName = os.Getenv("AWS_LAMBDA_FUNCTION_NAME")
	discordPublicKey = os.Getenv("DISCORD_PUBLIC_KEY")
}

// handler routes between webhook (Phase 1), admin API, and async action (Phase 2).
// Supports Lambda Function URL events, API Gateway v2 HTTP API, and API Gateway v1 proxy events.
func handler(ctx context.Context, rawEvent json.RawMessage) (interface{}, error) {
	// API Gateway v2 HTTP API — used for /admin/* routes (AWS_IAM auth via SpawnBotAdminCaller role).
	// Differentiated from Lambda Function URL by presence of requestContext.apiId.
	// Both use the same APIGatewayV2HTTPRequest type, but Function URLs don't set apiId.
	var apigwV2Req events.APIGatewayV2HTTPRequest
	if err := json.Unmarshal(rawEvent, &apigwV2Req); err == nil && apigwV2Req.RequestContext.APIID != "" {
		if strings.HasPrefix(apigwV2Req.RawPath, "/admin") {
			return handleAdminV2(ctx, reg, apigwV2Req)
		}
	}

	// Lambda Function URL event — used for /slack, /teams, /notify, and /{platform}/oauth routes.
	var fnURLReq events.LambdaFunctionURLRequest
	if err := json.Unmarshal(rawEvent, &fnURLReq); err == nil && fnURLReq.RequestContext.HTTP.Method != "" {
		apiReq := funcURLToAPIGW(fnURLReq)
		if apiReq.Path == "/notify" && apiReq.HTTPMethod == "POST" {
			return handleNotify(ctx, cfg, reg, apiReq)
		}
		// /{platform}/oauth and /{platform}/oauth/callback — pre-auth OAuth flow
		if platform, ok := oauthPlatform(apiReq.Path); ok {
			if strings.HasSuffix(apiReq.Path, "/oauth/callback") && apiReq.HTTPMethod == "GET" {
				return handleOAuthCallback(ctx, reg, platform, apiReq)
			}
			if strings.HasSuffix(apiReq.Path, "/oauth") && apiReq.HTTPMethod == "GET" {
				return handleOAuthRedirect(platform, apiReq)
			}
		}
		return handleWebhook(ctx, cfg, reg, apiReq)
	}

	// API Gateway v1 proxy event (backwards compatibility).
	var apiReq events.APIGatewayProxyRequest
	if err := json.Unmarshal(rawEvent, &apiReq); err == nil && apiReq.HTTPMethod != "" {
		if strings.HasPrefix(apiReq.Path, "/admin") {
			return handleAdminV1(ctx, reg, apiReq)
		}
		if apiReq.Path == "/notify" && apiReq.HTTPMethod == "POST" {
			return handleNotify(ctx, cfg, reg, apiReq)
		}
		return handleWebhook(ctx, cfg, reg, apiReq)
	}

	// Otherwise it's a BotAction payload from async self-invocation (Phase 2).
	return nil, handleAsyncAction(ctx, cfg, reg, rawEvent)
}

// funcURLToAPIGW adapts a Lambda Function URL request to the APIGatewayProxyRequest
// shape that handleWebhook expects. Lambda Function URLs base64-encode the body when
// it contains non-UTF-8 bytes or when the content type is application/x-www-form-urlencoded.
func funcURLToAPIGW(r events.LambdaFunctionURLRequest) events.APIGatewayProxyRequest {
	body := r.Body
	if r.IsBase64Encoded {
		decoded, err := base64.StdEncoding.DecodeString(r.Body)
		if err == nil {
			body = string(decoded)
		}
	}
	return events.APIGatewayProxyRequest{
		HTTPMethod:            r.RequestContext.HTTP.Method,
		Path:                  r.RawPath,
		Headers:               r.Headers,
		QueryStringParameters: r.QueryStringParameters,
		Body:                  body,
		IsBase64Encoded:       false,
	}
}

// invokeAsync kicks off Phase 2 as an async Lambda self-invocation.
func invokeAsync(ctx context.Context, action *BotAction) error {
	if functionName == "" {
		return fmt.Errorf("function name not set")
	}
	payload, err := json.Marshal(action)
	if err != nil {
		return fmt.Errorf("marshal action: %w", err)
	}
	_, err = lambdaClient.Invoke(ctx, &lambdasvc.InvokeInput{
		FunctionName:   aws.String(functionName),
		InvocationType: lambdatypes.InvocationTypeEvent,
		Payload:        payload,
	})
	return err
}

// lambdaDeadlineMargin is left between the end of any bounded work in a
// handler and the Lambda deadline, for the response and logging.
const lambdaDeadlineMargin = 2 * time.Second

// withinDeadline returns ctx bounded by budget, and by ctx's deadline less
// lambdaDeadlineMargin. Work a handler starts must finish before the handler
// returns, because Lambda freezes the execution environment then (#566, #572);
// this is the context to do it under. ctx should be the invocation's context:
// a shorter deadline on ctx is also treated as the Lambda deadline, margin and
// all.
func withinDeadline(ctx context.Context, budget time.Duration) (context.Context, context.CancelFunc) {
	if dl, ok := ctx.Deadline(); ok {
		if left := time.Until(dl) - lambdaDeadlineMargin; left < budget {
			budget = left
		}
	}
	return context.WithTimeout(ctx, budget)
}

// httpPost is a shared helper for posting JSON responses back to Slack/Teams.
func httpPost(url, contentType string, body []byte) error {
	resp, err := httpClient.Post(url, contentType, bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("http post: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		return fmt.Errorf("post returned %d", resp.StatusCode)
	}
	return nil
}

func getEnv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func logf(format string, args ...interface{}) {
	log.Printf(format, args...)
}

func main() {
	lambda.Start(handler)
}
