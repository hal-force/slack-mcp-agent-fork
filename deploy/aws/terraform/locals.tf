############################################
# Shared locals: naming + tags
############################################

locals {
  name = var.name_prefix

  tags = {
    Project     = var.name_prefix
    ManagedBy   = "terraform"
    Environment = "production"
  }
}
