-- DeepSeek is a personal API-balance connection. Existing provider values are
-- immutable; PostgreSQL enum additions are additive so deployed rows retain
-- their exact provider identity.
ALTER TYPE "ModelSubscriptionProvider" ADD VALUE IF NOT EXISTS 'deepseek';
