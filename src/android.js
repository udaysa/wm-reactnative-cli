const fs = require('fs-extra');
const propertiesReader = require('properties-reader');
const logger = require('./logger');
const config = require('./config');
const {
    exec
} = require('./exec');

const {
    validateForAndroid,
    checkForAndroidStudioAvailability
} = require('./requirements');
const { readAndReplaceFileContent } = require('./utils');

const loggerLabel = 'android-build';

function setKeyStoreValuesInGradleProps(content, keystoreName, ksData) {
    // TODO: if key pwds are changed, then just update the values.
    if(content.search(/MYAPP_UPLOAD_STORE_PASSWORD/gm) == -1) {
        return content.concat(` \n MYAPP_UPLOAD_STORE_FILE=${keystoreName}
        MYAPP_UPLOAD_KEY_ALIAS=${ksData.keyAlias}
        MYAPP_UPLOAD_STORE_PASSWORD=${ksData.storePassword}
        MYAPP_UPLOAD_KEY_PASSWORD=${ksData.keyPassword}`);
    }
    return content;
}
// Reference: http://reactnative.dev/docs/signed-apk-android
async function generateSignedApk(keyStore, storePassword, keyAlias, keyPassword, packageType) {
    const ksData = {storePassword: storePassword, keyAlias: keyAlias, keyPassword: keyPassword};
    const namesArr = keyStore.split('/');
    const keystoreName = namesArr[namesArr.length - 1];
    const filepath = config.src + 'android/app/' + keystoreName;

    fs.copyFileSync(keyStore, filepath);

    // edit file android/gradle.properties
    const gradlePropsPath = config.src + 'android/gradle.properties';
    if (fs.existsSync(gradlePropsPath)) {
        let data = fs.readFileSync(gradlePropsPath, 'utf8');
        let content = await setKeyStoreValuesInGradleProps(data, keystoreName, ksData);
        fs.writeFileSync(gradlePropsPath, content);
    }

    const appGradlePath = config.src + 'android/app/build.gradle';
    let content = fs.readFileSync(appGradlePath, 'utf8');
    content = await updateSigningConfig(content);
    fs.writeFileSync(appGradlePath, content);
    await generateAab(packageType);
}

function updateSigningConfig(content) {
    // TODO: replace one of the buildTypes to signingConfigs.release
    if(content.search(/if \(project.hasProperty\(\'MYAPP_UPLOAD_STORE_FILE\'\)\)/gm) == -1) {
        content = content.replace(/signingConfigs\.debug/g, 'signingConfigs.release');
        return content.replace(/signingConfigs \{/gm, `signingConfigs {
            release {
                if (project.hasProperty('MYAPP_UPLOAD_STORE_FILE')) {
                    storeFile file(MYAPP_UPLOAD_STORE_FILE)
                    storePassword MYAPP_UPLOAD_STORE_PASSWORD
                    keyAlias MYAPP_UPLOAD_KEY_ALIAS
                    keyPassword MYAPP_UPLOAD_KEY_PASSWORD
                }
            }`);
    }
    return content;
}

function updateJSEnginePreference() {
    const jsEngine = require(config.src + 'app.json').expo.jsEngine;
    const gradlePropsPath = config.src + 'android/gradle.properties';
    if (fs.existsSync(gradlePropsPath)) {
        let data = fs.readFileSync(gradlePropsPath, 'utf8');
        data = data.replace(/expo\.jsEngine=(jsc|hermes)/, `expo.jsEngine=${jsEngine}`)
        fs.writeFileSync(gradlePropsPath, data);
        logger.info({
            label: loggerLabel,
            message: `js engine is set as ${jsEngine}`
        });
    }
}

function setSigningConfigInGradle() {
    const gradlePath = config.src + 'android/app/build.gradle';

    let content = fs.readFileSync(gradlePath, 'utf8');
    content = updateSigningConfig(content);
    fs.writeFileSync(gradlePath, content);

    generateAab();
}

function addKeepFileEntries() {
    fs.mkdirSync(config.src + 'android/app/src/main/res/raw/', {recursive: true});
    const data = `<?xml version="1.0" encoding="utf-8"?>
    <resources xmlns:tools="http://schemas.android.com/tools"
tools:keep="@raw/*_fontawesome,@raw/*__streamlinelighticon, @raw/*_wavicon, @raw/*_streamlineregularicon" />`;
    fs.appendFileSync(config.src + 'android/app/src/main/res/raw/keep.xml', data);
}


async function generateAab(packageType) {
    try {
        // addKeepFileEntries();
        await exec('./gradlew', ['clean'], {
            cwd: config.src + 'android'
        });
        logger.info('****** invoking aab build *****');
        if (packageType === 'bundle') {
            await exec('./gradlew', [':app:bundleRelease'], {
                cwd: config.src + 'android'
            });
        } else {
            await exec('./gradlew', ['assembleRelease'], {
                cwd: config.src + 'android'
            });
        }
    }
    catch(e) {
        console.error('error generating release apk. ', e);
        return {
            success: false,
            errors: e
        }
    }
}

const endWith = (str, suffix) => {
    if (!str.endsWith(suffix)) {
        return str += suffix;
    }
    return str;
};

function findFile(path, nameregex) {
    const files = fs.readdirSync(path);
    const f = files.find(f => f.match(nameregex));
    return endWith(path, '/') + f;
}

function addProguardRule() {
    const proguardRulePath = config.src + 'android/app/proguard-rules.pro';
    if (fs.existsSync(proguardRulePath)) {
        var data = `-keep class com.facebook.react.turbomodule.** { *; }`;
        fs.appendFileSync(proguardRulePath,data, 'utf8');
        logger.info('***** added proguard rule ******')
    }
}

function updateOptimizationFlags() {
    logger.info('***** into optimization ******')
    const buildGradlePath = config.src + 'android/app/build.gradle';
    if (fs.existsSync(buildGradlePath)) {
        let content = fs.readFileSync(buildGradlePath, 'utf8');
        if (content.search(`def enableProguardInReleaseBuilds = false`) > -1) {
            content = content.replace(/def enableProguardInReleaseBuilds = false/gm, `def enableProguardInReleaseBuilds = true`)
                .replace(/minifyEnabled enableProguardInReleaseBuilds/gm, `minifyEnabled enableProguardInReleaseBuilds\n shrinkResources false\n`);
        }
        fs.writeFileSync(buildGradlePath, content);
    }
}

function updateAndroidBuildGradleFile(type) {
    const buildGradlePath = config.src + 'android/app/build.gradle';
    if (fs.existsSync(buildGradlePath)) {
        let content = fs.readFileSync(buildGradlePath, 'utf8');
        if (type === 'release') {
            if (content.search(`entryFile: "index.js"`) === -1) {
                content = content.replace(/^(?!\s)project\.ext\.react = \[/gm, `project.ext.react = [
        entryFile: "index.js",
        bundleAssetName: "index.android.bundle",
        bundleInRelease: true,`);
            } else {
                content = content.replace(/bundleInDebug\: true/gm, `bundleInDebug: false,
        bundleInRelease: true,`).replace(/devDisabledInDebug\: true/gm, ``)
                    .replace(/bundleInRelease\: false/gm, `bundleInRelease: true`);
            }
        } else {
            if (content.search(`entryFile: "index.js"`) === -1) {
                content = content.replace(/^(?!\s)project\.ext\.react = \[/gm, `project.ext.react = [
        entryFile: "index.js",
        bundleAssetName: "index.android.bundle",
        bundleInDebug: true,
        devDisabledInDebug: true,`);
            } else {
                content = content.replace(/bundleInDebug\: false/gm, `bundleInDebug: true`)
                    .replace(/devDisabledInDebug\: false/gm, `devDisabledInDebug: true`)
                    .replace(/bundleInRelease\: true/gm, `bundleInRelease: false`);
            }
        }
        fs.writeFileSync(buildGradlePath, content);
    }
}

function updateSettingsGradleFile(appName) {
    const path = config.src + 'android/settings.gradle';
    let content = fs.readFileSync(path, 'utf8');
    if (content.search(/^rootProject.name = \'\'/gm) > -1) {
        content = content.replace(/^rootProject.name = \'\'/gm, `rootProject.name = ${appName}`);
        fs.writeFileSync(path, content);
    }
}

async function embed(args) {
    const rnAndroidProject = `${config.src}/android`;
    const embedAndroidProject = `${config.src}/android-embed`;
    fs.mkdirpSync(embedAndroidProject);
    logger.info({
        label: loggerLabel,
        message: 'copying Native Android project.'
    });
    fs.copySync(args.modulePath, embedAndroidProject);
    fs.copySync(
        `${__dirname}/../templates/embed/android/fragment_react_native_app.xml`,
        `${embedAndroidProject}/rnApp/src/main/res/layout/fragment_react_native_app.xml`);
    fs.copySync(
        `${__dirname}/../templates/embed/android/ReactNativeAppFragment.java`,
        `${embedAndroidProject}/app/src/main/java/com/wavemaker/reactnative/ReactNativeAppFragment.java`);
    await readAndReplaceFileContent(
        `${embedAndroidProject}/app/src/main/java/com/wavemaker/reactnative/ReactNativeAppFragment.java`, 
        content => content.replace(/\$\{packageName\}/g, config.metaData.id));
    logger.info({
        label: loggerLabel,
        message: 'transforming Native Android files.'
    });
    await readAndReplaceFileContent(`${embedAndroidProject}/app/build.gradle`, 
        // TODO: This is a workaround to get build passed. Need to find appropriate fix.
        content => content.replace(/android[\s]{/, `project.ext.react = [
            enableHermes: true
        ];
        android {`));
            // fix for issue at https://github.com/facebook/react-native/issues/33926
            //.replace(/(com\.google\.android\.material:material:([\d\.]*))/, 'com.google.android.material:material:1.6.0'));
    logger.info({
        label: loggerLabel,
        message: 'Changed Native Android project.'
    });
    fs.copySync(`${rnAndroidProject}/app`, `${embedAndroidProject}/rnApp`);
    fs.copySync(`${rnAndroidProject}/build.gradle`, `${embedAndroidProject}/rnApp/root.build.gradle`);
    await readAndReplaceFileContent(`${embedAndroidProject}/rnApp/root.build.gradle`, (content) => {
        return content + `\nallprojects {
            configurations.all {
                resolutionStrategy {
                    force "com.facebook.react:react-native:" + REACT_NATIVE_VERSION
                    force "androidx.annotation:annotation:1.4.0"
                }
            }
        }`;
    });
    fs.copySync(`${rnAndroidProject}/settings.gradle`, `${embedAndroidProject}/rnApp/root.settings.gradle`);
    await readAndReplaceFileContent(`${embedAndroidProject}/rnApp/root.settings.gradle`, (content) => {
        return content.replace('rootProject.name', '//rootProject.name');
    });
    await readAndReplaceFileContent(`${embedAndroidProject}/rnApp/root.settings.gradle`, (content) => {
        return content.replace(`':app'`, `':rnApp'`);
    });
    await readAndReplaceFileContent(
        `${embedAndroidProject}/gradle.properties`,
        (content) => {
            const nativeProperties = propertiesReader(`${embedAndroidProject}/gradle.properties`);
            const rnProperties = propertiesReader(`${rnAndroidProject}/gradle.properties`);
            content += (Object.keys(rnProperties.getAllProperties())
            .filter(k => (nativeProperties.get(k) === null))
            .map(k => `\n${k}=${rnProperties.get(k)}`)).join('') || '';
            return content.replace('android.nonTransitiveRClass=true', 'android.nonTransitiveRClass=false');
        });
    await readAndReplaceFileContent(
        `${embedAndroidProject}/rnApp/src/main/AndroidManifest.xml`,
        (markup) => markup.replace(
            /<intent-filter>(.|\n)*?android:name="android.intent.category.LAUNCHER"(.|\n)*?<\/intent-filter>/g,
        '<!-- Removed React Native Main activity as launcher. Check the embedApp with Launcher activity -->')
        .replace(' android:theme="@style/AppTheme"', '')
        .replace('android:name=".MainApplication"', ''));
    await readAndReplaceFileContent(
        `${embedAndroidProject}/rnApp/build.gradle`,
        (content) => {
            return content.replace(
                `apply plugin: "com.android.application"`,
                `apply plugin: "com.android.library"`)
                .replace(/\s*applicationId.*/, '')
                .replace(`"/scripts/compose-source-maps.js",`,
                    `"/scripts/compose-source-maps.js",\n\tenableVmCleanup: false`)
                .replace('applicationVariants.all { variant', '/*applicationVariants.all { variant')
                .replace('implementation "com.facebook.react:react-native:+"', 'api "com.facebook.react:react-native:+"')
                .replace(
                    /(versionCodes.get\(abi\)\s\*\s1048576\s\+\sdefaultConfig\.versionCode[\s|\n]*\}[\s|\n]*\}[\s|\n]*\})/,
                    '$1*/'
                );
        });

    fs.copySync(
        `${__dirname}/../templates/embed/android/SplashScreenReactActivityLifecycleListener.kt`,
        `${config.src}/node_modules/expo-splash-screen/android/src/main/java/expo/modules/splashscreen/SplashScreenReactActivityLifecycleListener.kt`);
    await readAndReplaceFileContent(
        `${args.dest}/app.js`,
        (content) => content.replace('props = props || {};', 'props = props || {};\n\tprops.landingPage = props.landingPage || props.pageName;'));    
    fs.mkdirpSync(`${config.src}/android-embed/rnApp/src/main/assets`);
    await readAndReplaceFileContent(
        `${args.dest}/node_modules/@wavemaker/app-rn-runtime/components/dialogs/dialogcontent/dialogcontent.component.js`,
        (content) => content.replace('height', 'maxHeight'));    
    await exec('npx', ['react-native', 'bundle', '--platform',  'android',
            '--dev', 'false', '--entry-file', 'index.js',
            '--bundle-output', 'android-embed/rnApp/src/main/assets/index.android.bundle',
            '--assets-dest', 'android-embed/rnApp/src/main/res/'], {
        cwd: config.src
    });
    logger.info({
        label: loggerLabel,
        message: 'Changed React Native project.'
    });
}

async function invokeAndroidBuild(args) {
    let keyStore, storePassword, keyAlias,keyPassword;

    if (args.buildType === 'debug' && !args.aKeyStore) {
        keyStore = __dirname + '/../defaults/android-debug.keystore';
        keyAlias = 'androiddebugkey';
        keyPassword = 'android';
        storePassword = 'android';
    } else {
        keyStore = args.aKeyStore,
        storePassword = args.aStorePassword,
        keyAlias = args.aKeyAlias,
        keyPassword = args.aKeyPassword
    }

    if (!await checkForAndroidStudioAvailability()) {
        return {
            success: false
        }
    }

    updateJSEnginePreference();
    const appName = config.metaData.name;
    updateSettingsGradleFile(appName);
    if (args.buildType === 'release') {
        const errors = validateForAndroid(keyStore, storePassword, keyAlias, keyPassword);
        if (errors.length > 0) {
            return {
                success: false,
                errors: errors
            }
        }
        addProguardRule();
        updateOptimizationFlags();
        updateAndroidBuildGradleFile(args.buildType);
        await generateSignedApk(keyStore, storePassword, keyAlias, keyPassword, args.packageType);
    } else {
        updateAndroidBuildGradleFile(args.buildType);
        logger.info({
            label: loggerLabel,
            message: 'Updated build.gradle file with debug configuration'
        });
        try {
        await exec('./gradlew', ['assembleDebug'], {
            cwd: config.src + 'android'
        });
    } catch(e) {
        console.error('error generating release apk. ', e);
        return {
            success: false,
            errors: e
        }
    }
    }
    logger.info({
        label: loggerLabel,
        message: 'build completed'
    });
    const output = args.dest + 'output/android/';
    const outputFilePath = `${output}${appName}(${config.metaData.version}).${args.buildType}.${args.packageType === 'bundle' ? 'aab': 'apk'}`;

    let bundlePath = null;
    let folder = args.buildType === 'release' ? 'release' : 'debug';
    if (args.packageType === 'bundle') {
        bundlePath = findFile(`${args.dest}android/app/build/outputs/bundle/${folder}`, /\.aab?/);
    } else {
        bundlePath = findFile(`${args.dest}android/app/build/outputs/apk/${folder}`, /\.apk?/);
    }
    fs.mkdirSync(output, {recursive: true});
    fs.copyFileSync(bundlePath, outputFilePath);
    return {
        success: true,
        output: outputFilePath
    };
}

module.exports = {
    generateSignedApk: generateSignedApk,
    invokeAndroidBuild: invokeAndroidBuild,
    embed: embed
}
