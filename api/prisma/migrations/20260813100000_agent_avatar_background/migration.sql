-- Persist the selected pastel colour so an agent's visual identity stays stable
-- across sessions and can be shared by every avatar surface.
ALTER TABLE "agents" ADD COLUMN "avatar_background_color" TEXT;
