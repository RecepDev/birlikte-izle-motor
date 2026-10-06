plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "xyz.birlikteizle.mobil"
    compileSdk = 34

    defaultConfig {
        applicationId = "xyz.birlikteizle.mobil.motor"
        minSdk = 24
        targetSdk = 34
        versionCode = 31
        versionName = "0.31.0"
        // Telefonlar: FFmpeg ses çözücüsünün yerel kütüphaneleri yalnız bunlar için (APK şişmesin).
        ndk { abiFilters += listOf("arm64-v8a", "armeabi-v7a") }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            // Arkadaşlara dağıtım için: Play Store yok, hata ayıklama anahtarıyla imzalı APK yeterli.
            signingConfig = signingConfigs.getByName("debug")
        }
    }
    // TorrServer (Stremio'suz motor, bkz. Motor.kt) "lib….so" adıyla yerel kütüphane klasörüne
    // çıkarılmalı (Android yalnızca orayı çalıştırmaya izin veriyor); Go programı, sembolleri ayıklanmasın.
    packaging {
        jniLibs {
            useLegacyPackaging = true
            keepDebugSymbols += "**/libtorrserver.so"
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

// TorrServer'ın Android (arm64) programı derlemeden önce indiriliyor (depoya konmuyor, ~64 MB).
val torrserverSurum = "MatriX.145.2"
val torrserverSo = file("src/main/jniLibs/arm64-v8a/libtorrserver.so")
val torrserverIndir by tasks.registering {
    outputs.file(torrserverSo)
    doLast {
        if (!torrserverSo.exists()) {
            torrserverSo.parentFile.mkdirs()
            val gecici = File(torrserverSo.path + ".indiriliyor")
            uri("https://github.com/YouROK/TorrServer/releases/download/$torrserverSurum/TorrServer-android-arm64")
                .toURL().openStream().use { giris -> gecici.outputStream().use { giris.copyTo(it) } }
            gecici.renameTo(torrserverSo)
        }
    }
}
tasks.named("preBuild") { dependsOn(torrserverIndir) }

dependencies {
    val media3 = "1.2.1"
    implementation("androidx.media3:media3-exoplayer:$media3")
    // Uyumlu mod (host'ta dönüştürülmüş HLS) yedek olarak çalışsın diye.
    implementation("androidx.media3:media3-exoplayer-hls:$media3")
    implementation("androidx.media3:media3-ui:$media3")
    // DTS, TrueHD, AC3/EAC3 gibi telefonun çözemediği sesler için FFmpeg (Jellyfin'in derlemesi). Eskiden
    // bu dosyalarda ses Stremio'nun dönüştürücüsüyle (Uyumlu mod) geliyordu; Stremio'suz motorda o yok.
    implementation("org.jellyfin.media3:media3-ffmpeg-decoder:$media3+1")
    implementation("androidx.appcompat:appcompat:1.6.1")
    implementation("androidx.core:core-ktx:1.12.0")
    // Köprü betiğini sayfa betiklerinden önce çalıştırmak için (addDocumentStartJavaScript).
    implementation("androidx.webkit:webkit:1.8.0")
}
