############################################
# Networking
#
# Two modes, selected by var.create_vpc:
#   true  -> build a small VPC here: 2 public + 2 private subnets across 2 AZs,
#            an IGW, and a single NAT gateway (so the agent's App Runner VPC
#            connector has general internet egress in addition to the private
#            path to the MCP service).
#   false -> use an existing VPC + subnets supplied via variables.
#
# locals.tf resolves which set of ids is "active" regardless of mode, so every
# other file (rds.tf, apprunner.tf, iam.tf) only ever references
# local.vpc_id / local.private_subnet_ids / local.public_subnet_ids.
############################################

data "aws_availability_zones" "available" {
  state = "available"
}

# ---- New VPC (create_vpc = true) -----------------------------------------

resource "aws_vpc" "this" {
  count = var.create_vpc ? 1 : 0

  cidr_block           = var.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = merge(local.tags, { Name = "${local.name}-vpc" })
}

resource "aws_internet_gateway" "this" {
  count = var.create_vpc ? 1 : 0

  vpc_id = aws_vpc.this[0].id

  tags = merge(local.tags, { Name = "${local.name}-igw" })
}

resource "aws_subnet" "public" {
  count = var.create_vpc ? 2 : 0

  vpc_id                  = aws_vpc.this[0].id
  cidr_block              = cidrsubnet(var.vpc_cidr, 4, count.index)
  availability_zone       = data.aws_availability_zones.available.names[count.index]
  map_public_ip_on_launch = true

  tags = merge(local.tags, { Name = "${local.name}-public-${count.index}" })
}

resource "aws_subnet" "private" {
  count = var.create_vpc ? 2 : 0

  vpc_id            = aws_vpc.this[0].id
  cidr_block        = cidrsubnet(var.vpc_cidr, 4, count.index + 8)
  availability_zone = data.aws_availability_zones.available.names[count.index]

  tags = merge(local.tags, { Name = "${local.name}-private-${count.index}" })
}

resource "aws_eip" "nat" {
  count = var.create_vpc ? 1 : 0

  domain = "vpc"
  tags   = merge(local.tags, { Name = "${local.name}-nat-eip" })

  depends_on = [aws_internet_gateway.this]
}

# Single NAT gateway (kept simple/cheap for a partner deployment; not
# multi-AZ-redundant). Lives in the first public subnet.
resource "aws_nat_gateway" "this" {
  count = var.create_vpc ? 1 : 0

  allocation_id = aws_eip.nat[0].id
  subnet_id     = aws_subnet.public[0].id

  tags = merge(local.tags, { Name = "${local.name}-nat" })

  depends_on = [aws_internet_gateway.this]
}

resource "aws_route_table" "public" {
  count = var.create_vpc ? 1 : 0

  vpc_id = aws_vpc.this[0].id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.this[0].id
  }

  tags = merge(local.tags, { Name = "${local.name}-public-rt" })
}

resource "aws_route_table_association" "public" {
  count = var.create_vpc ? 2 : 0

  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public[0].id
}

resource "aws_route_table" "private" {
  count = var.create_vpc ? 1 : 0

  vpc_id = aws_vpc.this[0].id

  route {
    cidr_block     = "0.0.0.0/0"
    nat_gateway_id = aws_nat_gateway.this[0].id
  }

  tags = merge(local.tags, { Name = "${local.name}-private-rt" })
}

resource "aws_route_table_association" "private" {
  count = var.create_vpc ? 2 : 0

  subnet_id      = aws_subnet.private[count.index].id
  route_table_id = aws_route_table.private[0].id
}

# ---- Resolve "active" networking values regardless of mode ----------------

locals {
  vpc_id             = var.create_vpc ? aws_vpc.this[0].id : var.vpc_id
  private_subnet_ids = var.create_vpc ? aws_subnet.private[*].id : var.private_subnet_ids
  public_subnet_ids  = var.create_vpc ? aws_subnet.public[*].id : var.public_subnet_ids
}

# ---- Security groups --------------------------------------------------

# Attached to the agent's App Runner VPC connector (egress). Allows the agent
# to reach the MCP service (3927) and the Aurora cluster (5432) inside the VPC;
# outbound is unrestricted so the agent can also reach the internet via NAT
# (Slack API, LLM APIs, etc. that aren't routed through the private path).
resource "aws_security_group" "agent_egress" {
  name        = "${local.name}-agent-egress"
  description = "App Runner VPC connector SG for the slack-agent service"
  vpc_id      = local.vpc_id

  egress {
    description = "All outbound"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = merge(local.tags, { Name = "${local.name}-agent-egress" })
}

# NOTE: there is no separate security group for "port 3927" here. App
# Runner's VPC Ingress Connection does not attach a security group of its
# own — the actual access-control point for reaching the private MCP
# service is the security group on the VPC interface endpoint
# (aws_security_group.apprunner_vpce, defined in apprunner.tf), which
# already allows 443 from aws_security_group.agent_egress. Port 3927 is
# App Runner's internal listener port behind that PrivateLink endpoint and
# is not something a VPC security group can filter separately.
