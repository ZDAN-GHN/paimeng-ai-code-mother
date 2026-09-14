package com.zdan.paimengaicodebackend.config;

import lombok.Data;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.stereotype.Component;


@Data
@Component
@ConfigurationProperties(prefix = "internal-api")
public class InternalApiProperties {


    private String token;
}
