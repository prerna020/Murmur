const { withAndroidManifest, withDangerousMod, createRunOncePlugin } = require('@expo/config-plugins');
const fs = require('fs');
const path = require('path');

const DATA_EXTRACTION_RULES = `<?xml version="1.0" encoding="utf-8"?>
<data-extraction-rules>
    <cloud-backup>
        <exclude domain="root" path="." />
        <exclude domain="file" path="." />
        <exclude domain="database" path="." />
        <exclude domain="sharedpref" path="." />
        <exclude domain="external" path="." />
        <exclude domain="device_root" path="." />
        <exclude domain="device_file" path="." />
        <exclude domain="device_database" path="." />
        <exclude domain="device_sharedpref" path="." />
    </cloud-backup>
    <device-transfer>
        <exclude domain="root" path="." />
        <exclude domain="file" path="." />
        <exclude domain="database" path="." />
        <exclude domain="sharedpref" path="." />
        <exclude domain="external" path="." />
        <exclude domain="device_root" path="." />
        <exclude domain="device_file" path="." />
        <exclude domain="device_database" path="." />
        <exclude domain="device_sharedpref" path="." />
    </device-transfer>
</data-extraction-rules>
`;

const BACKUP_RULES = `<?xml version="1.0" encoding="utf-8"?>
<full-backup-content>
    <exclude domain="root" path="." />
    <exclude domain="file" path="." />
    <exclude domain="database" path="." />
    <exclude domain="sharedpref" path="." />
    <exclude domain="external" path="." />
    <exclude domain="device_root" path="." />
    <exclude domain="device_file" path="." />
    <exclude domain="device_database" path="." />
    <exclude domain="device_sharedpref" path="." />
</full-backup-content>
`;

const withBackupXmlFiles = (config) => {
  return withDangerousMod(config, [
    'android',
    async (config) => {
      const resXmlDir = path.join(
        config.modRequest.platformProjectRoot,
        'app',
        'src',
        'main',
        'res',
        'xml'
      );
      if (!fs.existsSync(resXmlDir)) {
        fs.mkdirSync(resXmlDir, { recursive: true });
      }

      fs.writeFileSync(
        path.join(resXmlDir, 'data_extraction_rules.xml'),
        DATA_EXTRACTION_RULES,
        'utf8'
      );

      fs.writeFileSync(
        path.join(resXmlDir, 'backup_rules.xml'),
        BACKUP_RULES,
        'utf8'
      );

      // Ensure useDevSupport = false in MainApplication.kt for standalone offline loading
      const mainAppFile = path.join(
        config.modRequest.platformProjectRoot,
        'app',
        'src',
        'main',
        'java',
        'com',
        'murmur',
        'app',
        'MainApplication.kt'
      );
      if (fs.existsSync(mainAppFile)) {
        let content = fs.readFileSync(mainAppFile, 'utf8');
        if (!content.includes('useDevSupport = false')) {
          content = content.replace(
            'context = applicationContext,',
            'context = applicationContext,\n      useDevSupport = false,'
          );
          fs.writeFileSync(mainAppFile, content, 'utf8');
        }
      }

      return config;
    },
  ]);
};

const withBackupManifest = (config) => {
  return withAndroidManifest(config, async (config) => {
    const mainApplication = config.modResults.manifest.application?.[0];
    if (mainApplication) {
      mainApplication.$['android:allowBackup'] = 'false';
      mainApplication.$['android:dataExtractionRules'] = '@xml/data_extraction_rules';
      mainApplication.$['android:fullBackupContent'] = '@xml/backup_rules';
    }
    return config;
  });
};

const withBackupExclusion = (config) => {
  config = withBackupXmlFiles(config);
  config = withBackupManifest(config);
  return config;
};

module.exports = createRunOncePlugin(withBackupExclusion, 'withBackupExclusion', '1.0.0');

