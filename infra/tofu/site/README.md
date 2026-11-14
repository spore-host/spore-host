# site — OpenTofu module

The CloudFront distribution in front of **spore.host** (`EY67INS5HDFLU`, infra
account 966362334030), brought under tofu by import (#717). It mirrors
[`../docs-site`](../docs-site): import onto the live resource, plan to zero
changes, then change things only through reviewed diffs.

The distribution was created in the console and had no IaC. It appears only in
`.github/workflows/deploy-site.yaml` (the invalidation) and `web/deploy.sh`.

## Stages

| Stage | What | Behaviour change |
|---|---|---|
| 1 | Import the distribution as it is (`security_headers = false`) | none |
| 2 | `security_headers = true`: create `spore-host-site-security-headers` and attach it to the default behavior | the headers below |
| 3 | S3 REST origin with OAC, block public access on `spore-host-website`, remove the bucket and policy steps from `web/deploy.sh` (#717) | origin and bucket; not in this module yet |

## What it manages

| Resource | Notes |
|---|---|
| `aws_cloudfront_distribution.site` | Imported by the `import` block in `main.tf`. Every setting is a variable captured from the live config by `live-tfvars.sh`, so nothing is guessed. `prevent_destroy`: a new distribution would mean a new domain name and a broken DNS alias. |
| `aws_cloudfront_response_headers_policy.site` | Stage 2 only (`count`). The #703 policy as on docs.spore.host: the CSP from `csp.txt`, HSTS (2 years, subdomains, **no preload**), `nosniff`, `X-Frame-Options: DENY`, `strict-origin-when-cross-origin`, a restrictive `Permissions-Policy`, and `Cross-Origin-Opener-Policy: same-origin`. |

**Not managed:** the bucket's objects (deploy-site.yaml), the bucket and its
public-read policy (stage 3), and the Route53 records.

## The CSP

`csp.txt` is one line, and both CloudFront and `scripts/check_docs_csp.py` read
it. `web-ci.yml` runs the checker against `web/dist`, so a PR that makes a page
load something the policy would block fails before it deploys. It allows
`'wasm-unsafe-eval'`, because Rive instantiates its vendored `rive.wasm` and
asciinema-player compiles its inline module. It allows no other origin for
scripts: both are vendored (#700). `main.tf` explains each directive. The
rebuilt portal (#645) will share this origin and will need more `connect-src`
(Globus Auth and AWS endpoints). Its slice changes `csp.txt` and the checker
holds it to that.

**HSTS preload** is off. On the apex it would put every spore.host subdomain on
the browsers' HTTPS-only list, which is hard to undo, so it needs its own
decision.

## Import (stage 1)

Read-only until the last step. Credentials are as in [`../README.md`](../README.md):

```sh
eval "$(aws configure export-credentials --profile spore-host-infra --format env)"
unset AWS_PROFILE; export AWS_REGION=us-east-1
cd infra/tofu/site
D="$HOME/.xtmp/site-717"; mkdir -p "$D"

# 1. Capture the live config. Both calls are read-only.
aws cloudfront get-distribution-config --id EY67INS5HDFLU --output json > "$D/distribution-config.json"
aws cloudfront list-tags-for-resource \
  --resource arn:aws:cloudfront::966362334030:distribution/EY67INS5HDFLU --output json > "$D/tags.json"

# 2. Render the variables. It refuses (and names the setting) a live config
#    with anything main.tf doesn't model; model that first.
./live-tfvars.sh "$D/distribution-config.json" "$D/tags.json" > terraform.tfvars.json

# 3. Plan. The state is empty, so this is the import.
tofu init
tofu plan -out "$D/import.tfplan"
```

The plan must say **`Plan: 1 to import, 0 to add, 0 to change, 0 to destroy.`**

- If the only differences are `retain_on_delete` and `wait_for_deployment`,
  that's fine: they exist only in tofu's state, so they change nothing in
  CloudFront.
- Anything else under `~` means `main.tf` and the live config disagree.
  **Don't apply.** To see the live config as HCL, run
  `tofu plan -generate-config-out="$D/live.tf"` in a scratch copy of this
  directory with the `aws_cloudfront_distribution.site` block removed. Then fix
  the model and plan again.

Then:

```sh
tofu apply "$D/import.tfplan"
tofu plan          # "No changes."
rm -r "$D"
```

Commit `terraform.tfvars.json`. It holds the distribution's settings, which are
not secret, and later plans need it.

## Security headers (stage 2)

In a PR, set `security_headers = true` (as the default in `main.tf`, or in
`terraform.tfvars.json`), then:

```sh
tofu plan    # 1 to add (the policy), 1 to change (response_headers_policy_id on the default behavior)
tofu apply
curl -sI https://spore.host/ | grep -iE 'content-security-policy|strict-transport|x-frame|x-content-type|referrer-policy|permissions-policy|cross-origin-opener'
```

Then open spore.host in a browser and check the console for CSP violations.
The Rive orb, the terminal demo, the install tabs and the theme toggle should
all work.

## State

Remote, in the infra account's state bucket (`site/terraform.tfstate`), locked
with an S3 lock file. Never commit state.
