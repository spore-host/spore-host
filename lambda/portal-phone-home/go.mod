module github.com/spore-host/spore-host/lambda/portal-phone-home

go 1.26.0

require (
	github.com/aws/aws-lambda-go v1.47.0
	github.com/aws/aws-sdk-go-v2/config v1.32.14
)

require (
	github.com/aws/aws-sdk-go-v2 v1.41.5 // indirect
	github.com/aws/aws-sdk-go-v2/credentials v1.19.14 // indirect
	github.com/aws/aws-sdk-go-v2/feature/dynamodb/attributevalue v1.20.37 // indirect
	github.com/aws/aws-sdk-go-v2/service/dynamodb v1.57.1 // indirect
	github.com/stretchr/testify v1.11.1 // indirect
)

require (
	github.com/aws/aws-sdk-go-v2/feature/ec2/imds v1.18.21 // indirect
	github.com/aws/aws-sdk-go-v2/internal/configsources v1.4.21 // indirect
	github.com/aws/aws-sdk-go-v2/internal/endpoints/v2 v2.7.21 // indirect
	github.com/aws/aws-sdk-go-v2/internal/ini v1.8.6 // indirect
	github.com/aws/aws-sdk-go-v2/service/dynamodbstreams v1.32.14 // indirect
	github.com/aws/aws-sdk-go-v2/service/internal/accept-encoding v1.13.7 // indirect
	github.com/aws/aws-sdk-go-v2/service/internal/endpoint-discovery v1.11.21 // indirect
	github.com/aws/aws-sdk-go-v2/service/internal/presigned-url v1.13.21 // indirect
	github.com/aws/aws-sdk-go-v2/service/signin v1.0.9 // indirect
	github.com/aws/aws-sdk-go-v2/service/sso v1.30.15 // indirect
	github.com/aws/aws-sdk-go-v2/service/ssooidc v1.35.19 // indirect
	github.com/aws/aws-sdk-go-v2/service/sts v1.41.10 // indirect
	github.com/aws/smithy-go v1.24.2 // indirect
	github.com/spore-host/spore-host/lambda/accountlifecycle v0.0.0
)

replace github.com/spore-host/spore-host/lambda/accountlifecycle => ../accountlifecycle
