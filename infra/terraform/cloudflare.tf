# Serves the bucket's public images from media.eyra.org.in through Cloudflare.
# Only new records are added here. The existing records for the website and
# email are not managed by Terraform and are never touched.

# A placeholder record: the hostname must exist and be proxied so the Worker
# below can answer for it. The address is never contacted.
resource "cloudflare_dns_record" "media" {
  zone_id = var.cloudflare_zone_id
  name    = var.media_hostname
  type    = "AAAA"
  content = "100::"
  proxied = true
  ttl     = 1
  comment = "Product images, served by the media Worker from the S3 bucket (managed by Terraform)"
}

resource "cloudflare_workers_script" "media" {
  account_id         = var.cloudflare_account_id
  script_name        = "eyra-media"
  main_module        = "media-worker.js"
  content            = replace(file("${path.module}/media-worker.js"), "__BUCKET_HOST__", local.bucket_host)
  compatibility_date = "2026-10-01"
}

resource "cloudflare_workers_route" "media" {
  zone_id = var.cloudflare_zone_id
  pattern = "${var.media_hostname}/*"
  script  = cloudflare_workers_script.media.script_name

  depends_on = [cloudflare_dns_record.media]
}

resource "cloudflare_zone_setting" "always_use_https" {
  zone_id    = var.cloudflare_zone_id
  setting_id = "always_use_https"
  value      = "on"
}

resource "cloudflare_zone_setting" "min_tls_version" {
  zone_id    = var.cloudflare_zone_id
  setting_id = "min_tls_version"
  value      = "1.2"
}
