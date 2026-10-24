# EYRA storage and CDN (Terraform)

Creates the S3 bucket for product images and private documents, an upload-only
IAM user for the backend, and the Cloudflare address `media.eyra.org.in` that
serves the public images through a small Worker.

Run from this folder, with `aws configure` done and `CLOUDFLARE_API_TOKEN` set
in the environment (never in a file):

1. `bash bootstrap.sh` once, to create the private bucket that holds Terraform's state.
2. `terraform init`
3. `terraform plan -out=tfplan`, read it, then `terraform apply tfplan`.

After the first apply, create an access key for the `eyra-medusa-uploader` user
in the AWS console and give it to Railway with the values from `terraform output`:
`S3_BUCKET`, `S3_REGION`, `S3_FILE_URL`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`.
Set `MEDUSA_IMAGE_HOSTS=media.eyra.org.in` on Vercel.

Cloudflare token permissions: DNS Edit, Zone Settings Edit, Workers Routes Edit
on the zone, and Workers Scripts Edit on the account.

Only new records are managed here. The existing website and email records are not touched.
