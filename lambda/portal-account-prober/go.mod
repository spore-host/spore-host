module github.com/spore-host/spore-host/lambda/portal-account-prober

go 1.26.0

require (
	github.com/aws/aws-lambda-go v1.47.0
	github.com/aws/aws-sdk-go-v2 v1.47.8
	github.com/aws/aws-sdk-go-v2/config v1.33.16
	github.com/aws/aws-sdk-go-v2/credentials v1.20.16
	github.com/aws/aws-sdk-go-v2/service/ec2 v1.344.2
	github.com/aws/aws-sdk-go-v2/service/sts v1.51.9
	github.com/aws/smithy-go v1.28.8
	github.com/spore-host/spore-host/lambda/accountlifecycle v0.0.0
)

require (
	github.com/aws/aws-sdk-go-v2/feature/dynamodb/attributevalue v1.21.20 // indirect
	github.com/aws/aws-sdk-go-v2/feature/ec2/imds v1.20.8 // indirect
	github.com/aws/aws-sdk-go-v2/internal/configsources v1.5.11 // indirect
	github.com/aws/aws-sdk-go-v2/internal/endpoints/v2 v2.8.11 // indirect
	github.com/aws/aws-sdk-go-v2/internal/v4a v1.5.11 // indirect
	github.com/aws/aws-sdk-go-v2/service/dynamodb v1.73.2 // indirect
	github.com/aws/aws-sdk-go-v2/service/dynamodbstreams v1.46.7 // indirect
	github.com/aws/aws-sdk-go-v2/service/internal/accept-encoding v1.13.24 // indirect
	github.com/aws/aws-sdk-go-v2/service/internal/endpoint-discovery v1.13.11 // indirect
	github.com/aws/aws-sdk-go-v2/service/internal/presigned-url v1.14.11 // indirect
	github.com/aws/aws-sdk-go-v2/service/signin v1.12.4 // indirect
	github.com/aws/aws-sdk-go-v2/service/sso v1.39.4 // indirect
	github.com/aws/aws-sdk-go-v2/service/ssooidc v1.44.4 // indirect
)

replace github.com/spore-host/spore-host/lambda/accountlifecycle => ../accountlifecycle
