CREATE TABLE "platform_banners" (
  "id" TEXT NOT NULL DEFAULT 'current',
  "text" TEXT NOT NULL,
  "link_url" TEXT,
  "active" BOOLEAN NOT NULL DEFAULT false,
  "revision" UUID NOT NULL,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "platform_banners_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "platform_news_articles" (
  "id" UUID NOT NULL,
  "title" TEXT NOT NULL,
  "body" TEXT NOT NULL,
  "image_url" TEXT,
  "youtube_url" TEXT,
  "published_at" TIMESTAMP(3),
  "publication_version" INTEGER,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "platform_news_articles_pkey" PRIMARY KEY ("id")
);

CREATE SEQUENCE "platform_news_publication_version_seq" AS INTEGER;

CREATE INDEX "platform_news_articles_publication_version_idx"
  ON "platform_news_articles"("publication_version");

CREATE TABLE "platform_news_images" (
  "article_id" UUID NOT NULL,
  "mime" TEXT NOT NULL,
  "bytes" BYTEA NOT NULL,
  CONSTRAINT "platform_news_images_pkey" PRIMARY KEY ("article_id")
);

ALTER TABLE "platform_news_images"
  ADD CONSTRAINT "platform_news_images_article_id_fkey"
  FOREIGN KEY ("article_id") REFERENCES "platform_news_articles"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "platform_news_read_states" (
  "user_id" UUID NOT NULL,
  "last_seen_publication_version" INTEGER NOT NULL DEFAULT 0,
  "notifications_muted" BOOLEAN NOT NULL DEFAULT false,
  CONSTRAINT "platform_news_read_states_pkey" PRIMARY KEY ("user_id")
);

ALTER TABLE "platform_news_read_states"
  ADD CONSTRAINT "platform_news_read_states_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
