# The identity .github/workflows/deploy-gcloud.yml assumes, and the Workload
# Identity Federation pool that lets it do so with no exported key.
#
# Gated on github_repository so a deployment that drives terraform by hand
# provisions none of it. Set it to `owner/repo` to turn it on; the workflow is
# separately inert until its own repository variables exist.

resource "google_service_account" "deploy" {
  count = var.github_repository == "" ? 0 : 1

  project      = var.project_id
  account_id   = "${var.name_prefix}-deploy"
  display_name = "Nessie ${var.environment} deploy pipeline"
}

resource "google_project_iam_member" "deploy" {
  for_each = var.github_repository == "" ? toset([]) : toset([
    # Deploy revisions, shift traffic, execute the migrate job.
    "roles/run.admin",
    # Push images.
    "roles/artifactregistry.writer",
  ])

  project = var.project_id
  role    = each.value
  member  = "serviceAccount:${google_service_account.deploy[0].email}"
}

# Deploying a revision means setting its service account, which Cloud Run
# treats as impersonation. Scoped to the four runtime accounts rather than
# granted project-wide.
resource "google_service_account_iam_member" "deploy_acts_as_runtime" {
  for_each = var.github_repository == "" ? toset([]) : toset(keys(local.runtime_accounts))

  service_account_id = google_service_account.runtime[each.value].name
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${google_service_account.deploy[0].email}"
}

resource "google_iam_workload_identity_pool" "github" {
  count = var.github_repository == "" ? 0 : 1

  project                   = var.project_id
  workload_identity_pool_id = "${var.name_prefix}-github"
  display_name              = "GitHub Actions"
}

resource "google_iam_workload_identity_pool_provider" "github" {
  count = var.github_repository == "" ? 0 : 1

  project                            = var.project_id
  workload_identity_pool_id          = google_iam_workload_identity_pool.github[0].workload_identity_pool_id
  workload_identity_pool_provider_id = "github"
  display_name                       = "GitHub OIDC"

  attribute_mapping = {
    "google.subject"       = "assertion.sub"
    "attribute.repository" = "assertion.repository"
  }

  # Without a condition any repository on github.com could mint tokens for this
  # pool. This pins it to one.
  attribute_condition = "assertion.repository == \"${var.github_repository}\""

  oidc {
    issuer_uri = "https://token.actions.githubusercontent.com"
  }
}

resource "google_service_account_iam_member" "github_impersonation" {
  count = var.github_repository == "" ? 0 : 1

  service_account_id = google_service_account.deploy[0].name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.github[0].name}/attribute.repository/${var.github_repository}"
}
