package com.zdan.paimengaicodebackend.platform.entity;

import com.mybatisflex.annotation.Column;
import com.mybatisflex.annotation.Id;
import com.mybatisflex.annotation.KeyType;
import com.mybatisflex.annotation.Table;
import com.mybatisflex.core.keygen.KeyGenerators;
import java.time.LocalDateTime;
import lombok.Data;

@Data
@Table("platform_requirement")
public class PlatformRequirement {

    @Id(keyType = KeyType.Generator, value = KeyGenerators.snowFlakeId)
    private Long id;

    @Column("application_id")
    private Long applicationId;

    @Column("parent_requirement_id")
    private Long parentRequirementId;

    private String kind;

    @Column("original_text")
    private String originalText;

    @Column("created_at")
    private LocalDateTime createdAt;
}
