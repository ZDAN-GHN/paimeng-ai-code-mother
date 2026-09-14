package com.zdan.paimengaicodebackend.exception;


public class ConcurrentRunException extends RuntimeException {

    public ConcurrentRunException(String message) {
        super(message);
    }
}
