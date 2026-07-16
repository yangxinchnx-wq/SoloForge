package com.soloforge.agent.pool;

import java.time.Instant;

/**
 * MessagePool entry types.
 */
public enum EntryType {
    TOOL_CALL,
    TOOL_RESULT,
    THINKING,
    OUTPUT,
    PEER_NOTICE
}
