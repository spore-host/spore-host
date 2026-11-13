# docs-site — OpenTofu module

Codifies the delivery layer for **docs.spore.host** (the VitePress documentation
site). Mirrors the `dns-updater` / `spore-bot` import-onto-live convention: the
live resources were created imperatively (console/CLI), and this module was
`tofu import`ed onto them, planning to a near-zero diff before it owned anything.

## Why this exists (#404)

`docs.spore.host` went fully dark — **503 on every request** — because the
CloudFront function `spore-host-docs-url-rewrite` (viewer-request) had **corrupt
code**: 141 bytes of binary garbage instead of valid JavaScript, so CloudFront
could not execute it. Republishing a correct function restored the site.

The root cause of the *fragility* was that none of the docs delivery layer was
under source control — the distribution, S3 origin, OAC, and especially the
**function code** were pure console artifacts. A bad manual edit could (and did)
take the whole site down with no reviewable history.

**The primary point of this module is that the CloudFront function code now lives
in `url-rewrite.js` and is the source of truth.** A change to it is a reviewable
diff, and `tofu apply` publishes it — corruption cannot silently ship.

## What it manages

| Resource | Notes |
|----------|-------|
| `aws_cloudfront_function.url_rewrite` | Code from `url-rewrite.js`. Clean URL `/x` → `/x.html`, `/` or dir → `index.html`, extensions pass through. |
| `aws_cloudfront_distribution.docs` | `E1F70PIGPUNRR0`, alias `docs.spore.host`. |
| `aws_cloudfront_origin_access_control.docs` | `E3KJVACTARMGFR` (S3 SigV4, signing always). |
| `aws_s3_bucket.docs` + policy + public-access-block | `spore-host-docs`. OAC-scoped read only. |
| `aws_route53_record.docs` | `docs.spore.host` A-alias → the distribution. |
| `aws_cloudfront_response_headers_policy.docs` | `spore-host-docs-security-headers` on the default behavior (#703): CSP from `csp.txt`, HSTS (2 years, subdomains, no preload), `nosniff`, `X-Frame-Options: DENY`, `strict-origin-when-cross-origin`, a restrictive `Permissions-Policy`, `Cross-Origin-Opener-Policy: same-origin`. New, so it is created rather than imported. |

## Changing the CSP

The policy is the one line in `csp.txt`; `main.tf` explains each directive.
CI builds the docs and runs `scripts/check_docs_csp.py` against that file, so a
page that starts loading from a new origin fails its PR instead of rendering
broken after deploy. Changing `csp.txt` changes nothing live until `tofu apply`.

After an apply, check the headers and that a page still renders:

```bash
curl -sI https://docs.spore.host/quickstart | grep -iE 'content-security|strict-transport|x-frame|x-content|referrer|permissions'
```

Then open the site with the browser console open: there should be no
`Content-Security-Policy` errors. Try search (Ctrl-K) and the dark-mode toggle.

## Deliberately NOT managed here

- **S3 object content** — the built VitePress site is deployed by
  `.github/workflows/docs.yaml` (`aws s3 sync docs/.vitepress/dist s3://spore-host-docs`).
  Tofu owns the bucket's *shape*, never its objects.

## Changing the URL-rewrite function

1. Edit `url-rewrite.js`.
2. `tofu plan` (credentials exported as in [`../README.md`](../README.md)) — review the `code` diff.
3. `tofu apply` — publishes to the LIVE stage automatically (`publish = true`).
4. Invalidate if needed:
   `aws cloudfront create-invalidation --distribution-id E1F70PIGPUNRR0 --paths "/*"`.

## Usage

```bash
eval "$(aws configure export-credentials --profile spore-host-infra --format env)"
unset AWS_PROFILE; export AWS_REGION=us-east-1
tofu init
tofu plan     # "No changes" once the resources are imported (see State)
tofu apply
```

## Import reference (already done)

```bash
tofu import aws_s3_bucket.docs spore-host-docs
tofu import aws_s3_bucket_public_access_block.docs spore-host-docs
tofu import aws_s3_bucket_policy.docs spore-host-docs
tofu import aws_cloudfront_origin_access_control.docs E3KJVACTARMGFR
tofu import aws_cloudfront_distribution.docs E1F70PIGPUNRR0
tofu import aws_cloudfront_function.url_rewrite spore-host-docs-url-rewrite   # by NAME, not ARN
tofu import aws_route53_record.docs Z0341053304H0DQXF6U4X_docs.spore.host_A
```

## State

Remote, in the infra account's state bucket (`docs-site/terraform.tfstate`),
locked with an S3 lock file (#580). **No state has been written for
this root yet**: import its resources before the first `plan`. Credentials and
the import rule: [`../README.md`](../README.md). Never commit state.
