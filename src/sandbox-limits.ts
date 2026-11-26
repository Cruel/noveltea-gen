/** Separate command metadata, canonical file bytes and model-visible output.
 * File payloads never consume argv space. Base64 overhead is bounded separately. */
export const SANDBOX_RECORD_BYTES = 1024 * 1024;
export const SANDBOX_COMMAND_BYTES = 8192;
export const SANDBOX_FILE_REQUEST_BYTES =
  Math.ceil(SANDBOX_RECORD_BYTES / 3) * 4 + SANDBOX_COMMAND_BYTES + 64;
export const SANDBOX_COMMAND_OUTPUT_BYTES = 64 * 1024;
export const SANDBOX_READ_PAGE_BYTES = 24 * 1024;
export const SANDBOX_MODEL_OUTPUT_BYTES = 48 * 1024;
