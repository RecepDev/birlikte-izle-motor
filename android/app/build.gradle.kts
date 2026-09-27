plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "xyz.birlikteizle.mobil"
    compileSdk = 34

    defaultConfig {
        applicationId = "xyz.birlikteizle.mobil"
        minSdk = 24
        targetSdk = 34
        versionCode = 2
        versionName = "0.2.0"
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            // Arkadaşlara dağıtım için: Play Store yok, hata ayıklama anahtarıyla imzalı APK yeterli.
            signingConfig = signingConfigs.getByName("debug")
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    val media3 = "1.2.1"
    implementation("androidx.media3:media3-exoplayer:$media3")
    // Uyumlu mod (host'ta dönüştürülmüş HLS) yedek olarak çalışsın diye.
    implementation("androidx.media3:media3-exoplayer-hls:$media3")
    implementation("androidx.media3:media3-ui:$media3")
    implementation("androidx.appcompat:appcompat:1.6.1")
    implementation("androidx.core:core-ktx:1.12.0")
    // Köprü betiğini sayfa betiklerinden önce çalıştırmak için (addDocumentStartJavaScript).
    implementation("androidx.webkit:webkit:1.8.0")
}
