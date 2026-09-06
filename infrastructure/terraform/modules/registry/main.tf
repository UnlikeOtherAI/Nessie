# Artifact Registry. One Docker repository holds every Nessie image: the
# single nessie-app image that serves the API, the worker and the migrate job,
# and the separate gateway image (which has its own Dockerfile and its own
# build context, so it is genuinely a second image and not a command override).

resource "google_artifact_registry_repository" "images" {
  project       = var.project_id
  location      = var.region
  repository_id = var.name_prefix
  description   = "Nessie container images"
  format        = "DOCKER"
  labels        = var.labels

  # Keeps the registry from growing by one image per deploy forever, which is
  # the same disk problem redeploy.sh solves with `docker rmi` on the Hetzner
  # host. Untagged parents of a retagged manifest go first.
  cleanup_policies {
    id     = "keep-recent-releases"
    action = "KEEP"

    most_recent_versions {
      keep_count = 30
    }
  }

  cleanup_policies {
    id     = "delete-untagged"
    action = "DELETE"

    condition {
      tag_state  = "UNTAGGED"
      older_than = "604800s"
    }
  }
}
