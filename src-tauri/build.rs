fn main() {
    // ビルド番号 = リポジトリのコミット数。macOS の About パネルに
    // 「Version 0.1.0 (N)」として表示されるよう Info.plist にマージする
    // (tauri-build は src-tauri/Info.plist を自動でマージする)。
    let build_number = std::process::Command::new("git")
        .args(["rev-list", "--count", "HEAD"])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_else(|| "0".to_string());

    let plist = format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleVersion</key>
    <string>{build_number}</string>
</dict>
</plist>
"#
    );
    let _ = std::fs::write("Info.plist", plist);
    println!("cargo:rerun-if-changed=../.git/HEAD");

    tauri_build::build()
}
