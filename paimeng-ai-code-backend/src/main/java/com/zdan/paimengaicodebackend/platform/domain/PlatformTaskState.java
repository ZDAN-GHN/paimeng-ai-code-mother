package com.zdan.paimengaicodebackend.platform.domain;

public enum PlatformTaskState {
    CREATED,
    READY,
    EXECUTING,
    BLOCKED,
    FAILED,
    VALIDATED,
    RELEASED,
    CANCELLED
}
