-- Org-level opt-out for EXIF/GPS metadata stripping on image uploads.
-- Default true: strip. Owners/admins can set false via PATCH /api/organizations/current.
ALTER TABLE "organizations" ADD COLUMN "strip_image_metadata" BOOLEAN NOT NULL DEFAULT true;
