# External HTTPS load balancer in front of the API.
#
# The load balancer, not the run.app URL, is the API's public address, for
# three reasons: it is what a stable DNS name can point at across a project
# move, it is where a Google-managed certificate for the operator's own domain
# lives, and it is the boundary that lets the Cloud Run service itself take
# INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER and stop answering its run.app URL.
#
# The certificate is a classic Google-managed certificate, which does NOT do
# wildcards. Turning on per-organisation team hostnames
# (docs/standards/team-hosts.md) means moving to Certificate Manager with DNS
# authorisation — recorded here and in the runbook as a constraint, not built.

resource "google_compute_global_address" "api" {
  name    = "${var.name_prefix}-api-ip"
  project = var.project_id
}

resource "google_compute_region_network_endpoint_group" "api" {
  name                  = "${var.name_prefix}-api-neg"
  project               = var.project_id
  region                = var.region
  network_endpoint_type = "SERVERLESS"

  cloud_run {
    service = var.api_service_name
  }
}

resource "google_compute_backend_service" "api" {
  name                  = "${var.name_prefix}-api-backend"
  project               = var.project_id
  load_balancing_scheme = "EXTERNAL_MANAGED"
  protocol              = "HTTPS"

  # Serverless NEGs are not health-checked by the load balancer; Cloud Run's
  # own startup and liveness probes decide what serves. The deploy workflow's
  # public-endpoint gate is the thing that proves the whole path, exactly as
  # verify_public_endpoint does on the Hetzner host today.
  backend {
    group = google_compute_region_network_endpoint_group.api.id
  }

  # Agent runs stream for minutes. The default 30 s backend timeout would cut
  # every long SSE response at the load balancer while Cloud Run happily kept
  # generating it.
  timeout_sec = var.backend_timeout_seconds

  log_config {
    enable      = true
    sample_rate = var.log_sample_rate
  }
}

resource "google_compute_url_map" "api" {
  name            = "${var.name_prefix}-api-urlmap"
  project         = var.project_id
  default_service = google_compute_backend_service.api.id
}

resource "google_compute_managed_ssl_certificate" "api" {
  name    = "${var.name_prefix}-api-cert"
  project = var.project_id

  managed {
    domains = [var.api_hostname]
  }

  # Google refuses to delete a certificate a proxy still references, so the
  # replacement has to exist before the old one goes.
  lifecycle {
    create_before_destroy = true
  }
}

resource "google_compute_target_https_proxy" "api" {
  name             = "${var.name_prefix}-api-https"
  project          = var.project_id
  url_map          = google_compute_url_map.api.id
  ssl_certificates = [google_compute_managed_ssl_certificate.api.id]
}

resource "google_compute_global_forwarding_rule" "https" {
  name                  = "${var.name_prefix}-api-https-fr"
  project               = var.project_id
  load_balancing_scheme = "EXTERNAL_MANAGED"
  target                = google_compute_target_https_proxy.api.id
  ip_address            = google_compute_global_address.api.id
  port_range            = "443"
}

# Port 80 exists only to redirect. A managed certificate also needs the domain
# to resolve to this address before it can be provisioned, so the HTTP listener
# is what makes the first-issue path work.
resource "google_compute_url_map" "redirect" {
  name    = "${var.name_prefix}-api-redirect"
  project = var.project_id

  default_url_redirect {
    https_redirect         = true
    redirect_response_code = "MOVED_PERMANENTLY_DEFAULT"
    strip_query            = false
  }
}

resource "google_compute_target_http_proxy" "redirect" {
  name    = "${var.name_prefix}-api-http"
  project = var.project_id
  url_map = google_compute_url_map.redirect.id
}

resource "google_compute_global_forwarding_rule" "http" {
  name                  = "${var.name_prefix}-api-http-fr"
  project               = var.project_id
  load_balancing_scheme = "EXTERNAL_MANAGED"
  target                = google_compute_target_http_proxy.redirect.id
  ip_address            = google_compute_global_address.api.id
  port_range            = "80"
}
