export declare const DEFAULT_FULL_STORY_TIMEOUT_MINUTES: number;
export declare const MAX_FULL_STORY_TIMEOUT_MINUTES: number;
export declare function fullStoryTimeouts(raw?: string): {
  minutes: number;
  monitorMs: number;
  testMs: number;
};
