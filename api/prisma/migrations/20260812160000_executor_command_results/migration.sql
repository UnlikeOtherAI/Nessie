-- Raw daemon results are retained only in encrypted form until the waiting
-- worker incorporates them into the model context; audit records keep a
-- digest and sanitized preview instead.
ALTER TABLE "executor_commands"
  ADD COLUMN "result_ciphertext" TEXT;
