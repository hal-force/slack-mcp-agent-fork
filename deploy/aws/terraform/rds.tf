############################################
# Aurora Serverless v2 (PostgreSQL)
#
# The agent image ships certs/rds-global-bundle.pem and the partner sets
# PGSSLROOTCERT=certs/rds-global-bundle.pem so Prisma verifies the RDS CA
# chain strictly (see docker-entrypoint.sh / src/install-kit/prisma.js). The
# DATABASE_URL built below is intentionally host-based with no sslmode query
# param — TLS verification is driven by PGSSLROOTCERT, not the URL.
############################################

resource "random_password" "db_master" {
  length           = 32
  special          = true
  override_special = "!#$%^&*()-_=+"
}

resource "aws_db_subnet_group" "this" {
  name       = "${local.name}-db-subnets"
  subnet_ids = local.private_subnet_ids

  tags = local.tags
}

# 5432 from the agent's App Runner VPC connector SG only.
resource "aws_security_group" "db" {
  name        = "${local.name}-db"
  description = "Aurora PostgreSQL SG for ${local.name}"
  vpc_id      = local.vpc_id

  ingress {
    description     = "Agent -> Postgres"
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [aws_security_group.agent_egress.id]
  }

  egress {
    description = "All outbound"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = merge(local.tags, { Name = "${local.name}-db" })
}

resource "aws_rds_cluster" "this" {
  cluster_identifier = "${local.name}-db"
  engine             = "aurora-postgresql"
  engine_mode        = "provisioned"
  # Point releases get retired for NEW-cluster creation over time. If apply
  # fails with an invalid-engine-version error, set var.aurora_engine_version to
  # one currently offered in your region:
  #   aws rds describe-db-engine-versions --engine aurora-postgresql \
  #     --query 'DBEngineVersions[].EngineVersion' --output text
  engine_version         = var.aurora_engine_version
  database_name          = var.db_name
  master_username        = var.db_username
  master_password        = random_password.db_master.result
  db_subnet_group_name   = aws_db_subnet_group.this.name
  vpc_security_group_ids = [aws_security_group.db.id]
  storage_encrypted      = true
  skip_final_snapshot    = true

  serverlessv2_scaling_configuration {
    min_capacity = 0.5
    max_capacity = 2
  }

  tags = local.tags
}

resource "aws_rds_cluster_instance" "this" {
  cluster_identifier = aws_rds_cluster.this.id
  instance_class     = "db.serverless"
  engine             = aws_rds_cluster.this.engine
  engine_version     = aws_rds_cluster.this.engine_version

  tags = local.tags
}

locals {
  # urlencode() the credentials: random_password's default character set
  # (and override_special below) can include characters such as # % & = +
  # that are structurally significant in a URI (fragment/percent-escape/
  # query delimiters) and would otherwise corrupt DATABASE_URL parsing.
  database_url = "postgresql://${urlencode(var.db_username)}:${urlencode(random_password.db_master.result)}@${aws_rds_cluster.this.endpoint}:5432/${var.db_name}"
}
