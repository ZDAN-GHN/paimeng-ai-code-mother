package com.zdan.paimengaicodebackend.platform.entity;

import com.mybatisflex.annotation.Column;
import com.mybatisflex.annotation.Id;
import com.mybatisflex.annotation.KeyType;
import com.mybatisflex.annotation.Table;
import com.mybatisflex.core.keygen.KeyGenerators;
import java.time.LocalDateTime;
import lombok.Data;

@Data
@Table("platform_trusted_profile_version")
public class PlatformTrustedProfileVersion {

    @Id(keyType = KeyType.Generator, value = KeyGenerators.snowFlakeId)
    private Long id;

    @Column("application_id")
    private Long applicationId;

    @Column("version_number")
    private Long versionNumber;

    @Column("profile_json")
    private String profileJson;

    @Column("created_at")
    private LocalDateTime createdAt;
}
