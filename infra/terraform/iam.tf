# The identity the Medusa backend (Railway) uses. It can read, write and delete
# files in the media bucket and nothing else. The access key is created by hand
# in the AWS console so the secret never enters Terraform's state.

resource "aws_iam_user" "uploader" {
  name = "eyra-medusa-uploader"
}

data "aws_iam_policy_document" "uploader" {
  statement {
    sid       = "ListBucket"
    actions   = ["s3:ListBucket", "s3:GetBucketLocation"]
    resources = [aws_s3_bucket.media.arn]
  }

  statement {
    sid = "ManageFiles"
    actions = [
      "s3:PutObject",
      "s3:PutObjectAcl",
      "s3:GetObject",
      "s3:GetObjectAcl",
      "s3:DeleteObject",
      "s3:AbortMultipartUpload",
    ]
    resources = ["${aws_s3_bucket.media.arn}/*"]
  }
}

resource "aws_iam_user_policy" "uploader" {
  name   = "media-bucket-access"
  user   = aws_iam_user.uploader.name
  policy = data.aws_iam_policy_document.uploader.json
}
