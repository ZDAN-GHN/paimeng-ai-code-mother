package com.zdan.paimengaicodebackend.generator;

import cn.hutool.core.lang.Dict;
import cn.hutool.setting.yaml.YamlUtil;
import com.mybatisflex.codegen.Generator;
import com.mybatisflex.codegen.config.GlobalConfig;
import com.zaxxer.hikari.HikariDataSource;
import java.util.Map;

public class MybatisFlexCodeGenerator {

    private static final String[] TABLE_NAMES = { "chat_history" };

    public static void main(String[] args) {
        Dict dict = YamlUtil.loadByPath("application.yml");
        Map<String, Object> dataSourceConfig = dict.getByPath("spring.datasource");
        String url = String.valueOf(dataSourceConfig.get("url"));
        String username = String.valueOf(dataSourceConfig.get("username"));
        String password = String.valueOf(dataSourceConfig.get("password"));

        HikariDataSource dataSource = new HikariDataSource();
        dataSource.setJdbcUrl(url);
        dataSource.setUsername(username);
        dataSource.setPassword(password);

        GlobalConfig globalConfig = createGlobalConfig();

        Generator generator = new Generator(dataSource, globalConfig);

        generator.generate();
    }

    public static GlobalConfig createGlobalConfig() {
        GlobalConfig globalConfig = new GlobalConfig();

        globalConfig.getPackageConfig().setBasePackage("com.zdan.paimengaicodebackend.genresult");

        final String isDelete = "isDelete";
        globalConfig
            .getStrategyConfig()

            .setGenerateTable(TABLE_NAMES)
            .setLogicDeleteColumn(isDelete);

        globalConfig.enableEntity().setWithLombok(true).setJdkVersion(21);

        globalConfig.enableMapper();
        globalConfig.enableMapperXml();

        globalConfig.enableService();
        globalConfig.enableServiceImpl();

        globalConfig.enableController();

        globalConfig
            .getJavadocConfig()
            .setAuthor("LXH")

            .setSince("");

        return globalConfig;
    }
}
