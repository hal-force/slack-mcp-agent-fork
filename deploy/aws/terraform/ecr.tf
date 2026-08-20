############################################
# ECR repositories
#
# Two-phase apply note (see README.md): these repos must exist and have an
# image pushed to them BEFORE the App Runner services in apprunner.tf can be
# created successfully (aws_apprunner_service validates the image at create
# time). Run `terraform apply -target=aws_ecr_repository.tableau_mcp
# -target=aws_ecr_repository.slack_agent` first, push images, then run a full
# `terraform apply`.
############################################

resource "aws_ecr_repository" "tableau_mcp" {
  name                 = "${local.name}-tableau-mcp"
  image_tag_mutability = "MUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }

  tags = local.tags
}

resource "aws_ecr_repository" "slack_agent" {
  name                 = "${local.name}-slack-agent"
  image_tag_mutability = "MUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }

  tags = local.tags
}

# Keep the last 10 images in each repo; expire anything older.
locals {
  ecr_lifecycle_policy = jsonencode({
    rules = [
      {
        rulePriority = 1
        description  = "Keep last 10 images"
        selection = {
          tagStatus   = "any"
          countType   = "imageCountMoreThan"
          countNumber = 10
        }
        action = {
          type = "expire"
        }
      }
    ]
  })
}

resource "aws_ecr_lifecycle_policy" "tableau_mcp" {
  repository = aws_ecr_repository.tableau_mcp.name
  policy     = local.ecr_lifecycle_policy
}

resource "aws_ecr_lifecycle_policy" "slack_agent" {
  repository = aws_ecr_repository.slack_agent.name
  policy     = local.ecr_lifecycle_policy
}
