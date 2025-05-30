const fs = require('fs-extra');
const logger = require('./logger');
const config = require('./config');
const plist = require('plist');
const xcode = require('xcode');
const {
    exec
} = require('./exec');
const {
    validateForIos
 } = require('./requirements');
 const { readAndReplaceFileContent, iterateFiles } = require('./utils');

 const loggerLabel = 'Generating ipa file';

async function importCertToKeyChain(keychainName, certificate, certificatePassword) {
    await exec('security', ['create-keychain', '-p', keychainName, keychainName], {log: false});
    await exec('security', ['unlock-keychain', '-p', keychainName, keychainName], {log: false});
    await exec('security', ['set-keychain-settings', '-t', '3600', keychainName], {log: false});
    let keychains = await exec('security', ['list-keychains', '-d', 'user'], {log: false});
    keychains = keychains.map(k => k.replace(/[\"\s]+/g, '')).filter(k => k !== '');
    await exec('security', ['list-keychains', '-d', 'user', '-s', keychainName, ...keychains], {log: false});
    await exec('security',
        ['import',
        certificate,
        '-k', keychainName,
        '-P', certificatePassword,
        '-T', '/usr/bin/codesign',
        '-T', '/usr/bin/productsign',
        '-T', '/usr/bin/productbuild',
        '-T', '/Applications/Xcode.app'], {log: false});
    await exec('security', ['set-key-partition-list', '-S', 'apple-tool:,apple:,codesign', '-s', '-k', keychainName, keychainName], {log: false});
    logger.info({
        label: loggerLabel,
        message: `Cerificate at (${certificate}) imported in (${keychainName})`
    });
    let signingDetails = await exec('security', ['find-identity', '-v', '-p', 'codesigning'], {log: false});
    console.log(signingDetails);
    return async () => {
        keychains = keychains.map(k => k.replace(/[\"\s]+/g, ''));
        await exec('security', ['list-keychains', '-d', 'user', '-s', ...keychains], {log: false});
        await deleteKeyChain(keychainName);
        logger.info({
            label: loggerLabel,
            message: `removed keychain (${keychainName}).`
        });
    };
}

async function deleteKeyChain(keychainName) {
    await exec('security', ['delete-keychain', keychainName]);
}


async function extractUUID(provisionalFile) {
    const content = await exec('grep', ['UUID', '-A1', '-a', provisionalFile], {log: false});
    return content.join('\n').match(/[-A-F0-9]{36}/i)[0];
}

async function getLoginKeyChainName() {
    const content = await exec('security list-keychains | grep login.keychain', null, {
        shell: true
    });
    return content[0].substring(content[0].lastIndexOf('/') + 1, content[0].indexOf('-'));
}

async function extractTeamId(provisionalFile) {
    const content = await exec('grep', ['TeamIdentifier', '-A2', '-a', provisionalFile], {log: false});
    return content[2].match(/>[A-Z0-9]+/i)[0].substr(1);
}

async function getUsername() {
    const content = await exec('id', ['-un'], false);
    return content[0];
}

function updateJSEnginePreference() {
    const jsEngine = require(config.src + 'app.json').expo.jsEngine;
    const podJSON = config.src + 'ios/Podfile.properties.json';
    if (fs.existsSync(podJSON)) {
        let data = require(podJSON, 'utf8');
        data['expo.jsEngine'] = jsEngine;
        fs.writeFileSync(podJSON, JSON.stringify(data, null, 4));
        logger.info({
            label: loggerLabel,
            message: `js engine is set as ${jsEngine}`
        });
    }
}

function addResourceFileToProject(iosProject, path, opt, group) {
    const file = iosProject.addFile(path, group);
    file.uuid = iosProject.generateUuid();
    iosProject.addToPbxBuildFileSection(file);        // PBXBuildFile
    iosProject.addToPbxResourcesBuildPhase(file);     // PBXResourcesBuildPhase
    iosProject.addToPbxFileReferenceSection(file);    // PBXFileReference
    if (group) {
        if (iosProject.getPBXGroupByKey(group)) {
            iosProject.addToPbxGroup(file, group);        //Group other than Resources (i.e. 'splash')
        }
        else if (iosProject.getPBXVariantGroupByKey(group)) {
            iosProject.addToPbxVariantGroup(file, group);  // PBXVariantGroup
        }
    }
    return file;
}


async function embed(args) {
    const rnIosProject = config.src;
    const embedProject = `${rnIosProject}ios-embed`;
    fs.copySync(args.mp, embedProject);
    const rnModulePath = `${embedProject}/rnApp`;
    fs.removeSync(rnModulePath);
    fs.mkdirpSync(rnModulePath);
    fs.copyFileSync(`${__dirname}/../templates/embed/ios/ReactNativeView.swift`, `${rnModulePath}/ReactNativeView.swift`);
    fs.copyFileSync(`${__dirname}/../templates/embed/ios/ReactNativeView.h`, `${rnModulePath}/ReactNativeView.h`);
    fs.copyFileSync(`${__dirname}/../templates/embed/ios/ReactNativeView.m`, `${rnModulePath}/ReactNativeView.m`);
    await readAndReplaceFileContent(
        `${rnIosProject}/app.js`,
        (content) => content.replace('props = props || {};', 'props = props || {};\n\tprops.landingPage = props.landingPage || props.pageName;'));
    await readAndReplaceFileContent(
        `${rnIosProject}/node_modules/expo-splash-screen/build/SplashScreen.js`,
        (content) => {
            return content.replace('return await ExpoSplashScreen.preventAutoHideAsync();', 
            `
            // return await ExpoSplashScreen.preventAutoHideAsync();
            return Promise.resolve();
            `).replace('return await ExpoSplashScreen.hideAsync();', 
            `
            // return await ExpoSplashScreen.hideAsync();
            return Promise.resolve();
            `)
        }
    )
    await exec('npx', ['react-native', 'bundle', '--platform',  'ios',
            '--dev', 'false', '--entry-file', 'index.js',
            '--bundle-output', 'ios-embed/rnApp/main.jsbundle',
            '--assets-dest', 'ios-embed/rnApp'], {
        cwd: config.src
    });
    await exec('pod', ['install'], {
        cwd: embedProject
    });
    logger.info({
        label: loggerLabel,
        message: 'Changed Native Ios project.'
    });
}

async function invokeiosBuild(args) {
    const certificate = args.iCertificate;
    const certificatePassword = args.iCertificatePassword;
    const provisionalFile = args.iProvisioningFile;
    const buildType = args.buildType;
    const errors = validateForIos(certificate, certificatePassword, provisionalFile, buildType);
        if (errors.length > 0) {
            return {
                success: false,
                errors: errors
            }
        }
        updateJSEnginePreference();
        const random = Date.now();
        const username = await getUsername();
        const keychainName = `wm-reactnative-${random}.keychain`;
        const provisionuuid =  await extractUUID(provisionalFile);
        let codeSignIdentity = await exec(`openssl pkcs12 -in ${certificate} -passin pass:${certificatePassword} -nodes | openssl x509 -noout -subject -nameopt multiline | grep commonName | sed -n 's/ *commonName *= //p'`, null, {
            shell: true
        });
        codeSignIdentity = codeSignIdentity[1];
        let useModernBuildSystem = 'YES';
        logger.info({
            label: loggerLabel,
            message: `provisional UUID : ${provisionuuid}`
        });
        const developmentTeamId = await extractTeamId(provisionalFile);
        logger.info({
            label: loggerLabel,
            message: `developmentTeamId : ${developmentTeamId}`
        });
        const ppFolder = `/Users/${username}/Library/MobileDevice/Provisioning\ Profiles`;
        fs.mkdirSync(ppFolder, {
            recursive: true
        })
        const targetProvisionsalPath = `${ppFolder}/${provisionuuid}.mobileprovision`;
        fs.copyFileSync(provisionalFile, targetProvisionsalPath);
        logger.info({
            label: loggerLabel,
            message: `copied provisionalFile (${provisionalFile}).`
        });
        const removeKeyChain = await importCertToKeyChain(keychainName, certificate, certificatePassword);

        try {
            // XCode14 issue https://github.com/expo/expo/issues/19759
            // This is not required when expo 47 is used.
            await readAndReplaceFileContent(`${config.src}ios/Podfile`, (content) => {
                return content.replace('__apply_Xcode_12_5_M1_post_install_workaround(installer)', 
                '__apply_Xcode_12_5_M1_post_install_workaround(installer)' + '\n' +
                '    # Add these lines for Xcode 14 builds' + '\n' +
                '    installer.pods_project.targets.each do |target| ' +   '\n' +
                '       if target.respond_to?(:product_type) and target.product_type == "com.apple.product-type.bundle"' + '\n' +
                '           target.build_configurations.each do |config|'+ '\n' +
                '               config.build_settings[\'CODE_SIGNING_ALLOWED\'] = \'NO\'' + '\n' +
                '           end' + '\n' +
                '       end' + '\n' +
                '   end')
            });
            await exec('pod', ['install'], {cwd: config.src + 'ios'});
            return await xcodebuild(args, codeSignIdentity, provisionuuid, developmentTeamId);
        } catch (e) {
            console.error(e);
            return {
                errors: e,
                success: false
            }
        } finally {
            await removeKeyChain();
        }
}


async function updateInfoPlist(appName, PROVISIONING_UUID) {
    return await new Promise(resolve => {
        try {
        const appId = config.metaData.id;

        const infoPlistpath = config.src + 'ios/build/' + appName +'.xcarchive/Info.plist';
         fs.readFile(infoPlistpath, async function (err, data) {
            const content = data.toString().replace('<key>ApplicationProperties</key>',
                `<key>compileBitcode</key>
            <true/>
            <key>provisioningProfiles</key>
            <dict>
                <key>${appId}</key>
                <string>${PROVISIONING_UUID}</string>
            </dict>
            <key>ApplicationProperties</key>
            `);
            await fs.writeFile(infoPlistpath, Buffer.from(content));
            resolve('success');
        });
    } catch (e) {
        resolve('error', e);
    }
    });
}

const removePushNotifications = (projectDir, projectName) => {
    const dir = `${projectDir}ios/${projectName}/`;
    const entitlements = dir + fs.readdirSync(dir).find(f => f.endsWith('entitlements'));
    const o = plist.parse(fs.readFileSync(entitlements, 'utf8'));
    delete o['aps-environment'];
    fs.writeFileSync(entitlements, plist.build(o), 'utf8');
    logger.info({
        label: loggerLabel,
        message: `removed aps-environment from entitlements`
    });
};

const endWith = (str, suffix) => {
    if (!str.endsWith(suffix)) {
        return str += suffix;
    }
    return str;
};

function findFile(path, nameregex) {
    const files = fs.readdirSync(path);
    const f = files.find(f => f.match(nameregex));
    return f ? endWith(path, '/') + f : '';
}

async function xcodebuild(args, CODE_SIGN_IDENTITY_VAL, PROVISIONING_UUID, DEVELOPMENT_TEAM) {
    try {
        let xcworkspacePath = findFile(config.src + 'ios', /\.xcworkspace?/) || findFile(config.src + 'ios', /\.xcodeproj?/);
        if (!xcworkspacePath) {
            return {
                errors: '.xcworkspace or .xcodeproj files are not found in ios directory',
                success: false
            }
        }
        const projectName = fs.readdirSync(`${config.src}ios`)
            .find(f => f.endsWith('xcodeproj'))
            .split('.')[0];
        const pathArr = xcworkspacePath.split('/');
        const xcworkspaceFileName = pathArr[pathArr.length - 1];
        const fileName = xcworkspaceFileName.split('.')[0];
        removePushNotifications(config.src, fileName);
        let _buildType;
        if (args.buildType === 'development' || args.buildType === 'debug') {
            _buildType = 'Debug';
            // Instead of loading from metro server, load it from the bundle.
            await readAndReplaceFileContent(`${config.src}ios/${projectName}.xcodeproj/project.pbxproj`, (content) => {
                return content.replace('SKIP_BUNDLING=1', 'FORCE_BUNDLING=1')
            });
            await readAndReplaceFileContent(`${config.src}ios/${projectName}/AppDelegate.mm`, (content) => {
                return content.replace(
                    'return [[RCTBundleURLProvider sharedSettings] jsBundleURLForBundleRoot:@"index"];',
                    'return [[NSBundle mainBundle] URLForResource:@"main" withExtension:@"jsbundle"];')
            });
        } else {
            _buildType = 'Release';
        }
        const env = {
            RCT_NO_LAUNCH_PACKAGER: 1
        };
        await exec('xcodebuild', [
            '-workspace', fileName + '.xcworkspace',
            '-scheme', fileName,
            '-configuration', _buildType,
            '-destination', 'generic/platform=iOS',
            '-archivePath', 'build/' + fileName + '.xcarchive', 
            'CODE_SIGN_IDENTITY=' + CODE_SIGN_IDENTITY_VAL,
            'PROVISIONING_PROFILE=' + PROVISIONING_UUID,
            'CODE_SIGN_STYLE=Manual',
            'archive'], {
            cwd: config.src + 'ios',
            env: env
        });

        const status = await updateInfoPlist(fileName, PROVISIONING_UUID);
        if (status === 'success') {
            await exec('xcodebuild', [
                '-exportArchive',
                '-archivePath', 'build/' + fileName + '.xcarchive',
                '-exportOptionsPlist', 'build/' + fileName + '.xcarchive/Info.plist', 
                '-exportPath',
                'build'], {
                cwd: config.src + 'ios',
                env: env
            });
            const output =  args.dest + 'output/ios/';
            const outputFilePath = `${output}${fileName}(${config.metaData.version}).${args.buildType}.ipa`;
            fs.mkdirSync(output, {recursive: true});
            fs.copyFileSync(findFile(`${args.dest}ios/build/`, /\.ipa?/), outputFilePath);
            return {
                success: true,
                output: outputFilePath
            }
        }
    } catch (e) {
        logger.error({
            label: loggerLabel,
            message: e
        });
        console.error(e);
        return {
            errors: e,
            success: false
        }
    }
}

module.exports = {
    invokeiosBuild: invokeiosBuild,
    embed: embed
}
