# Secret Manager.
#
# Two kinds of secret live here and they are handled differently on purpose.
#
# GENERATED — the database URL, the auth secret and the two halves of the GCS
# interoperability key. Terraform mints them and writes the version, because
# nothing outside this tree knows them and a human copying them by hand is a
# human pasting them somewhere they persist.
#
# OPERATOR-POPULATED — the Ledger app key, the UOA billing pair, the DeepSignal
# key, the Infisical token and the rest. Terraform creates the *container* and
# never the version: these are issued by other systems, and a terraform tree
# that could write them would need to be handed them.
#
# A Cloud Run revision that references a secret with no version never becomes
# ready, which is why the root module wires only what `injected_secret_env`
# names. Create, populate, then inject.

resource "google_secret_manager_secret" "generated" {
  for_each = toset([
    "database-url",
    "auth-secret",
    "storage-access-key-id",
    "storage-secret-access-key",
  ])

  project   = var.project_id
  secret_id = "${var.name_prefix}-${each.key}"
  labels    = var.labels

  replication {
    auto {}
  }
}

resource "google_secret_manager_secret" "managed" {
  for_each = var.managed_secret_env

  project   = var.project_id
  secret_id = "${var.name_prefix}-${each.value}"
  labels    = var.labels

  replication {
    auto {}
  }
}

resource "google_secret_manager_secret" "gateway" {
  for_each = var.gateway_secret_env

  project   = var.project_id
  secret_id = "${var.name_prefix}-${each.value}"
  labels    = var.labels

  replication {
    auto {}
  }
}

# 32 bytes of hex. Signs sessions and bootstrap tokens and encrypts MCP OAuth
# secrets, so it must be stable across replicas and across deploys — an
# ephemeral one invalidates every session on every revision.
resource "random_id" "auth_secret" {
  byte_length = 32
}

resource "google_secret_manager_secret_version" "database_url" {
  secret      = google_secret_manager_secret.generated["database-url"].id
  secret_data = var.database_url
}

resource "google_secret_manager_secret_version" "auth_secret" {
  secret      = google_secret_manager_secret.generated["auth-secret"].id
  secret_data = random_id.auth_secret.hex
}

resource "google_secret_manager_secret_version" "storage_access_key_id" {
  secret      = google_secret_manager_secret.generated["storage-access-key-id"].id
  secret_data = var.storage_access_key_id
}

resource "google_secret_manager_secret_version" "storage_secret_access_key" {
  secret      = google_secret_manager_secret.generated["storage-secret-access-key"].id
  secret_data = var.storage_secret_access_key
}
