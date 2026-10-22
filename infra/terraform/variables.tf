variable "aws_region" {
  description = "AWS region for the media bucket."
  type        = string
  default     = "ap-south-1"
}

variable "bucket_name" {
  description = "Name of the media bucket. S3 names are global, so this must be unique."
  type        = string
  default     = "eyra-media-prod"
}

variable "cloudflare_zone_id" {
  description = "Zone ID of eyra.org.in (Cloudflare, domain Overview page). Not secret."
  type        = string
}

variable "cloudflare_account_id" {
  description = "Cloudflare account ID (domain Overview page). Not secret."
  type        = string
}

variable "media_hostname" {
  description = "Public address that serves product images."
  type        = string
  default     = "media.eyra.org.in"
}

variable "noncurrent_version_days" {
  description = "How long overwritten or deleted file versions are kept before they are removed."
  type        = number
  default     = 90
}
