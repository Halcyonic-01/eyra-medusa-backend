# One bucket for everything Medusa stores. Product images are uploaded with a
# public-read ACL and are served through Cloudflare. Invoices, credit notes and
# GSTR-1 files are uploaded as private objects and are never public.

locals {
  bucket_host = "${var.bucket_name}.s3.${var.aws_region}.amazonaws.com"
}

resource "aws_s3_bucket" "media" {
  bucket = var.bucket_name
}

# Medusa's S3 provider sets a per-file ACL on every upload, so ACLs must stay on.
resource "aws_s3_bucket_ownership_controls" "media" {
  bucket = aws_s3_bucket.media.id

  rule {
    object_ownership = "BucketOwnerPreferred"
  }
}

# Public-read ACLs on images are allowed. Public bucket policies stay blocked.
resource "aws_s3_bucket_public_access_block" "media" {
  bucket = aws_s3_bucket.media.id

  block_public_acls       = false
  ignore_public_acls      = false
  block_public_policy     = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_versioning" "media" {
  bucket = aws_s3_bucket.media.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "media" {
  bucket = aws_s3_bucket.media.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

# Current files never expire (invoices must be kept for years). Only replaced
# or deleted older versions are cleaned up.
resource "aws_s3_bucket_lifecycle_configuration" "media" {
  bucket = aws_s3_bucket.media.id

  rule {
    id     = "clean-old-versions"
    status = "Enabled"

    filter {}

    noncurrent_version_expiration {
      noncurrent_days = var.noncurrent_version_days
    }

    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }

  depends_on = [aws_s3_bucket_versioning.media]
}

# Refuse any request that is not encrypted in transit.
data "aws_iam_policy_document" "bucket_policy" {
  statement {
    sid     = "DenyInsecureTransport"
    effect  = "Deny"
    actions = ["s3:*"]

    resources = [
      aws_s3_bucket.media.arn,
      "${aws_s3_bucket.media.arn}/*",
    ]

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
}

resource "aws_s3_bucket_policy" "media" {
  bucket = aws_s3_bucket.media.id
  policy = data.aws_iam_policy_document.bucket_policy.json

  depends_on = [aws_s3_bucket_public_access_block.media]
}
