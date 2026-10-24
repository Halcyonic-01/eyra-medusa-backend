terraform {
  required_version = ">= 1.10.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
    # Version 5 renamed most Cloudflare resources; do not loosen this pin.
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.0"
    }
  }

  # State lives in a private, encrypted S3 bucket made once by bootstrap.sh.
  # use_lockfile stops two runs from writing at the same time.
  backend "s3" {
    bucket       = "eyra-terraform-state-322170133276"
    key          = "eyra/storage-and-cdn.tfstate"
    region       = "ap-south-1"
    encrypt      = true
    use_lockfile = true
  }
}

# Credentials are never written here: AWS uses the aws configure profile and
# Cloudflare reads CLOUDFLARE_API_TOKEN from the environment.
provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      project   = "eyra"
      managedby = "terraform"
    }
  }
}

provider "cloudflare" {}
