output "bucket_name" {
  value = aws_s3_bucket.media.id
}

output "uploader_user" {
  description = "Create an access key for this user in the AWS console, then give it to Railway."
  value       = aws_iam_user.uploader.name
}

output "railway_env" {
  description = "Backend (Railway) settings. Add S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY from the AWS console."
  value = {
    S3_BUCKET   = aws_s3_bucket.media.id
    S3_REGION   = var.aws_region
    S3_FILE_URL = "https://${var.media_hostname}"
  }
}

output "vercel_env" {
  description = "Storefront (Vercel) setting, needed at build time."
  value = {
    MEDUSA_IMAGE_HOSTS = var.media_hostname
  }
}
