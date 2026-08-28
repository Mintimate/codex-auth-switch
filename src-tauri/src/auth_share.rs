use base64::{
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
    Engine as _,
};
use flate2::{read::ZlibDecoder, write::ZlibEncoder, Compression};
use image::{DynamicImage, ImageFormat, ImageReader, Luma};
use qrcode::{EcLevel, QrCode};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    fmt,
    io::{Cursor, Read, Write},
};

const TRANSFER_TEXT_PREFIX_V3: &str = "CAS3:";
const TRANSFER_QR_PREFIX_V3: &[u8] = b"CAS3Q";
const LEGACY_TEXT_PREFIX_V2: &str = "CAS2:";
const LEGACY_QR_PREFIX_V2: &[u8] = b"CAS2Q";
const MAX_ENVELOPE_BYTES: usize = 128 * 1024;
const MAX_SHARE_TEXT_BYTES: usize = 256 * 1024;
const MAX_QR_IMAGE_BYTES: usize = 12 * 1024 * 1024;
const MAX_QR_IMAGE_DIMENSION: u32 = 4_096;
const QR_IMAGE_SIZE: u32 = 720;

#[derive(Debug)]
pub(crate) enum AuthShareError {
    InvalidPayload,
    PayloadTooLarge,
    QrTooLarge,
    InvalidQrImage,
    QrNotFound,
    RenderFailed,
}

impl fmt::Display for AuthShareError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::InvalidPayload => "迁移内容无效或已损坏",
            Self::PayloadTooLarge => "迁移内容超过允许大小",
            Self::QrTooLarge => "此账号的迁移内容超过单个二维码容量，请改用剪贴板",
            Self::InvalidQrImage => "二维码图片无效或尺寸过大",
            Self::QrNotFound => "图片中未识别到有效的一次性迁移二维码",
            Self::RenderFailed => "生成迁移二维码失败",
        })
    }
}

impl std::error::Error for AuthShareError {}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct CompactAuthTransferV3 {
    #[serde(rename = "d")]
    id_token: String,
    #[serde(rename = "r")]
    refresh_token: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct LegacyAuthTransferV2 {
    #[serde(rename = "l")]
    label: String,
    #[serde(rename = "d")]
    id_token: String,
    #[serde(rename = "a")]
    access_token: String,
    #[serde(rename = "r")]
    refresh_token: String,
    #[serde(rename = "i")]
    account_id: String,
    #[serde(rename = "t", default, skip_serializing_if = "Option::is_none")]
    last_refresh: Option<String>,
}

#[derive(Debug, Clone)]
pub(crate) enum ImportedAuth {
    RefreshSeed {
        id_token: String,
        refresh_token: String,
    },
    LegacySnapshot {
        label: String,
        auth: Value,
    },
}

pub(crate) fn encode_text(auth: &Value) -> Result<String, AuthShareError> {
    let compressed = encode_v3_compressed(auth)?;
    Ok(format!(
        "{TRANSFER_TEXT_PREFIX_V3}{}",
        URL_SAFE_NO_PAD.encode(compressed)
    ))
}

pub(crate) fn encode_qr_payload(auth: &Value) -> Result<Vec<u8>, AuthShareError> {
    let compressed = encode_v3_compressed(auth)?;
    let mut payload = Vec::with_capacity(TRANSFER_QR_PREFIX_V3.len() + compressed.len());
    payload.extend_from_slice(TRANSFER_QR_PREFIX_V3);
    payload.extend_from_slice(&compressed);
    Ok(payload)
}

fn encode_v3_compressed(auth: &Value) -> Result<Vec<u8>, AuthShareError> {
    let envelope = CompactAuthTransferV3 {
        id_token: required_auth_token(auth, "id_token")?.to_string(),
        refresh_token: required_auth_token(auth, "refresh_token")?.to_string(),
    };
    serialize_and_compress(&envelope)
}

fn serialize_and_compress<T: Serialize>(envelope: &T) -> Result<Vec<u8>, AuthShareError> {
    let json = serde_json::to_vec(&envelope).map_err(|_| AuthShareError::InvalidPayload)?;
    if json.len() > MAX_ENVELOPE_BYTES {
        return Err(AuthShareError::PayloadTooLarge);
    }

    compress(&json)
}

pub(crate) fn decode_text(text: &str) -> Result<ImportedAuth, AuthShareError> {
    let text = text.trim();
    if text.len() > MAX_SHARE_TEXT_BYTES {
        return Err(AuthShareError::PayloadTooLarge);
    }
    let (encoded, version) = if let Some(encoded) = text.strip_prefix(TRANSFER_TEXT_PREFIX_V3) {
        (encoded, 3)
    } else if let Some(encoded) = text.strip_prefix(LEGACY_TEXT_PREFIX_V2) {
        (encoded, 2)
    } else {
        return Err(AuthShareError::InvalidPayload);
    };
    let compressed = URL_SAFE_NO_PAD
        .decode(encoded)
        .map_err(|_| AuthShareError::InvalidPayload)?;
    match version {
        3 => decode_v3_compressed(&compressed),
        2 => decode_v2_compressed(&compressed),
        _ => Err(AuthShareError::InvalidPayload),
    }
}

fn decode_qr_payload(payload: &[u8]) -> Result<ImportedAuth, AuthShareError> {
    if let Some(compressed) = payload.strip_prefix(TRANSFER_QR_PREFIX_V3) {
        decode_v3_compressed(compressed)
    } else if let Some(compressed) = payload.strip_prefix(LEGACY_QR_PREFIX_V2) {
        decode_v2_compressed(compressed)
    } else {
        Err(AuthShareError::InvalidPayload)
    }
}

fn required_auth_token<'a>(auth: &'a Value, field: &str) -> Result<&'a str, AuthShareError> {
    auth.get("tokens")
        .and_then(Value::as_object)
        .and_then(|tokens| tokens.get(field))
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or(AuthShareError::InvalidPayload)
}

fn compress(json: &[u8]) -> Result<Vec<u8>, AuthShareError> {
    let mut encoder = ZlibEncoder::new(Vec::new(), Compression::best());
    encoder
        .write_all(json)
        .map_err(|_| AuthShareError::InvalidPayload)?;
    encoder.finish().map_err(|_| AuthShareError::InvalidPayload)
}

fn decompress(compressed: &[u8]) -> Result<Vec<u8>, AuthShareError> {
    let decoder = ZlibDecoder::new(compressed);
    let mut json = Vec::new();
    decoder
        .take((MAX_ENVELOPE_BYTES + 1) as u64)
        .read_to_end(&mut json)
        .map_err(|_| AuthShareError::InvalidPayload)?;
    if json.len() > MAX_ENVELOPE_BYTES {
        return Err(AuthShareError::PayloadTooLarge);
    }
    Ok(json)
}

fn decode_v3_compressed(compressed: &[u8]) -> Result<ImportedAuth, AuthShareError> {
    let json = decompress(compressed)?;
    let envelope: CompactAuthTransferV3 =
        serde_json::from_slice(&json).map_err(|_| AuthShareError::InvalidPayload)?;
    if envelope.id_token.trim().is_empty() || envelope.refresh_token.trim().is_empty() {
        return Err(AuthShareError::InvalidPayload);
    }
    Ok(ImportedAuth::RefreshSeed {
        id_token: envelope.id_token,
        refresh_token: envelope.refresh_token,
    })
}

fn decode_v2_compressed(compressed: &[u8]) -> Result<ImportedAuth, AuthShareError> {
    let json = decompress(compressed)?;
    let envelope: LegacyAuthTransferV2 =
        serde_json::from_slice(&json).map_err(|_| AuthShareError::InvalidPayload)?;
    if envelope.label.trim().is_empty()
        || envelope.id_token.trim().is_empty()
        || envelope.access_token.trim().is_empty()
        || envelope.refresh_token.trim().is_empty()
        || envelope.account_id.trim().is_empty()
        || envelope
            .last_refresh
            .as_deref()
            .is_some_and(|last_refresh| chrono::DateTime::parse_from_rfc3339(last_refresh).is_err())
    {
        return Err(AuthShareError::InvalidPayload);
    }
    let LegacyAuthTransferV2 {
        label,
        id_token,
        access_token,
        refresh_token,
        account_id,
        last_refresh,
    } = envelope;
    let mut auth = serde_json::json!({
        "auth_mode": "chatgpt",
        "OPENAI_API_KEY": null,
        "tokens": {
            "id_token": id_token,
            "access_token": access_token,
            "refresh_token": refresh_token,
            "account_id": account_id,
        },
    });
    if let Some(last_refresh) = last_refresh {
        auth["last_refresh"] = Value::String(last_refresh);
    }
    Ok(ImportedAuth::LegacySnapshot { label, auth })
}

#[cfg(test)]
pub(crate) fn encode_legacy_text(label: &str, auth: &Value) -> Result<String, AuthShareError> {
    let compressed = encode_v2_compressed(label, auth)?;
    Ok(format!(
        "{LEGACY_TEXT_PREFIX_V2}{}",
        URL_SAFE_NO_PAD.encode(compressed)
    ))
}

#[cfg(test)]
fn encode_legacy_qr_payload(label: &str, auth: &Value) -> Result<Vec<u8>, AuthShareError> {
    let compressed = encode_v2_compressed(label, auth)?;
    let mut payload = Vec::with_capacity(LEGACY_QR_PREFIX_V2.len() + compressed.len());
    payload.extend_from_slice(LEGACY_QR_PREFIX_V2);
    payload.extend_from_slice(&compressed);
    Ok(payload)
}

#[cfg(test)]
fn encode_v2_compressed(label: &str, auth: &Value) -> Result<Vec<u8>, AuthShareError> {
    let envelope = LegacyAuthTransferV2 {
        label: label.to_string(),
        id_token: required_auth_token(auth, "id_token")?.to_string(),
        access_token: required_auth_token(auth, "access_token")?.to_string(),
        refresh_token: required_auth_token(auth, "refresh_token")?.to_string(),
        account_id: required_auth_token(auth, "account_id")?.to_string(),
        last_refresh: auth
            .get("last_refresh")
            .and_then(Value::as_str)
            .map(str::to_string),
    };
    serialize_and_compress(&envelope)
}

pub(crate) fn render_qr_data_url(payload: &[u8]) -> Result<String, AuthShareError> {
    let code = QrCode::with_error_correction_level(payload, EcLevel::L)
        .map_err(|_| AuthShareError::QrTooLarge)?;
    let image = code
        .render::<Luma<u8>>()
        .min_dimensions(QR_IMAGE_SIZE, QR_IMAGE_SIZE)
        .quiet_zone(true)
        .build();
    let mut png = Cursor::new(Vec::new());
    DynamicImage::ImageLuma8(image)
        .write_to(&mut png, ImageFormat::Png)
        .map_err(|_| AuthShareError::RenderFailed)?;
    Ok(format!(
        "data:image/png;base64,{}",
        STANDARD.encode(png.into_inner())
    ))
}

// 二维码图片通过 IPC 以 base64 字符串传输（number[] 会让 12MB 图片膨胀成千万级 JSON
// 数组元素）。先按膨胀后的长度卡一道，再交给 decode_qr_image 卡解码后的字节数。
const MAX_QR_BASE64_BYTES: usize = (MAX_QR_IMAGE_BYTES / 3 + 1) * 4;

pub(crate) fn decode_qr_image_base64(image: &str) -> Result<ImportedAuth, AuthShareError> {
    let encoded = image.trim();
    if encoded.is_empty() || encoded.len() > MAX_QR_BASE64_BYTES {
        return Err(AuthShareError::InvalidQrImage);
    }
    let bytes = STANDARD
        .decode(encoded)
        .map_err(|_| AuthShareError::InvalidQrImage)?;
    decode_qr_image(&bytes)
}

pub(crate) fn decode_qr_image(image_bytes: &[u8]) -> Result<ImportedAuth, AuthShareError> {
    if image_bytes.is_empty() || image_bytes.len() > MAX_QR_IMAGE_BYTES {
        return Err(AuthShareError::InvalidQrImage);
    }
    let reader = ImageReader::new(Cursor::new(image_bytes))
        .with_guessed_format()
        .map_err(|_| AuthShareError::InvalidQrImage)?;
    let (width, height) = reader
        .into_dimensions()
        .map_err(|_| AuthShareError::InvalidQrImage)?;
    if width == 0
        || height == 0
        || width > MAX_QR_IMAGE_DIMENSION
        || height > MAX_QR_IMAGE_DIMENSION
    {
        return Err(AuthShareError::InvalidQrImage);
    }
    let image = ImageReader::new(Cursor::new(image_bytes))
        .with_guessed_format()
        .map_err(|_| AuthShareError::InvalidQrImage)?
        .decode()
        .map_err(|_| AuthShareError::InvalidQrImage)?
        .to_luma8();
    let mut prepared = rqrr::PreparedImage::prepare(image);
    for grid in prepared.detect_grids() {
        let mut content = Vec::new();
        if grid.decode_to(&mut content).is_err() {
            continue;
        }
        if let Ok(imported) = decode_qr_payload(&content) {
            return Ok(imported);
        }
    }
    Err(AuthShareError::QrNotFound)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn sample_auth() -> Value {
        json!({
            "auth_mode": "chatgpt",
            "OPENAI_API_KEY": null,
            "tokens": {
                "id_token": "header.payload.signature",
                "access_token": "header.payload.signature",
                "refresh_token": "refresh-token",
                "account_id": "account-a"
            },
            "last_refresh": "2026-08-28T00:00:00Z"
        })
    }

    fn noisy_text(length: usize, mut state: u32) -> String {
        const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
        (0..length)
            .map(|_| {
                state ^= state << 13;
                state ^= state >> 17;
                state ^= state << 5;
                ALPHABET[state as usize % ALPHABET.len()] as char
            })
            .collect()
    }

    fn realistic_sized_auth() -> Value {
        json!({
            "auth_mode": "chatgpt",
            "OPENAI_API_KEY": null,
            "tokens": {
                "id_token": format!("{}.{}.{}", noisy_text(36, 1), noisy_text(1_300, 2), noisy_text(342, 3)),
                "access_token": format!("{}.{}.{}", noisy_text(36, 4), noisy_text(1_100, 5), noisy_text(342, 6)),
                "refresh_token": noisy_text(110, 7),
                "account_id": "account-a"
            }
        })
    }

    fn assert_legacy_auth_matches(decoded: &Value, original: &Value) {
        for field in ["id_token", "access_token", "refresh_token", "account_id"] {
            assert_eq!(
                decoded.pointer(&format!("/tokens/{field}")),
                original.pointer(&format!("/tokens/{field}"))
            );
        }
        assert!(decoded["OPENAI_API_KEY"].is_null());
        assert_eq!(decoded.get("last_refresh"), original.get("last_refresh"));
    }

    #[test]
    fn cas3_text_contains_only_the_refresh_seed() {
        let auth = sample_auth();
        let encoded = encode_text(&auth).unwrap();
        assert!(encoded.starts_with(TRANSFER_TEXT_PREFIX_V3));
        assert!(!encoded.contains("refresh-token"));
        assert!(encoded
            .strip_prefix(TRANSFER_TEXT_PREFIX_V3)
            .unwrap()
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_')));
        let compressed = URL_SAFE_NO_PAD
            .decode(encoded.strip_prefix(TRANSFER_TEXT_PREFIX_V3).unwrap())
            .unwrap();
        let json: Value = serde_json::from_slice(&decompress(&compressed).unwrap()).unwrap();
        assert_eq!(
            json.as_object()
                .unwrap()
                .keys()
                .map(String::as_str)
                .collect::<std::collections::BTreeSet<_>>(),
            ["d", "r"].into_iter().collect()
        );

        let decoded = decode_text(&encoded).unwrap();
        let ImportedAuth::RefreshSeed {
            id_token,
            refresh_token,
        } = decoded
        else {
            panic!("CAS3 应解码为刷新种子");
        };
        assert_eq!(id_token, "header.payload.signature");
        assert_eq!(refresh_token, "refresh-token");
    }

    #[test]
    fn cas3_is_shorter_than_the_legacy_cas2_snapshot() {
        let auth = realistic_sized_auth();
        let cas3 = encode_text(&auth).unwrap();
        let cas2 = encode_legacy_text("个人账号", &auth).unwrap();

        assert!(cas3.len() < cas2.len());
    }

    #[test]
    fn cas3_qr_round_trips_through_png() {
        let auth = realistic_sized_auth();
        let payload = encode_qr_payload(&auth).unwrap();
        assert!(payload.starts_with(TRANSFER_QR_PREFIX_V3));
        let data_url = render_qr_data_url(&payload).unwrap();
        let png = STANDARD
            .decode(data_url.strip_prefix("data:image/png;base64,").unwrap())
            .unwrap();
        let decoded = decode_qr_image(&png).unwrap();
        let ImportedAuth::RefreshSeed {
            id_token,
            refresh_token,
        } = decoded
        else {
            panic!("CAS3 二维码应解码为刷新种子");
        };
        assert_eq!(
            id_token,
            auth.pointer("/tokens/id_token")
                .and_then(Value::as_str)
                .unwrap()
        );
        assert_eq!(
            refresh_token,
            auth.pointer("/tokens/refresh_token")
                .and_then(Value::as_str)
                .unwrap()
        );
    }

    #[test]
    fn legacy_cas2_text_and_qr_remain_importable() {
        let auth = sample_auth();
        let text = encode_legacy_text("个人账号", &auth).unwrap();
        let ImportedAuth::LegacySnapshot {
            label,
            auth: decoded,
        } = decode_text(&text).unwrap()
        else {
            panic!("CAS2 文本应解码为旧版快照");
        };
        assert_eq!(label, "个人账号");
        assert_legacy_auth_matches(&decoded, &auth);

        let payload = encode_legacy_qr_payload("个人账号", &auth).unwrap();
        let data_url = render_qr_data_url(&payload).unwrap();
        let png = STANDARD
            .decode(data_url.strip_prefix("data:image/png;base64,").unwrap())
            .unwrap();
        let ImportedAuth::LegacySnapshot {
            label,
            auth: decoded,
        } = decode_qr_image(&png).unwrap()
        else {
            panic!("CAS2 二维码应解码为旧版快照");
        };
        assert_eq!(label, "个人账号");
        assert_legacy_auth_matches(&decoded, &auth);
    }

    #[test]
    fn rejects_unrecognized_text_and_images() {
        assert!(matches!(
            decode_text("not-a-share"),
            Err(AuthShareError::InvalidPayload)
        ));
        assert!(matches!(
            decode_text("CAS-AUTH:1:LEGACY"),
            Err(AuthShareError::InvalidPayload)
        ));
        assert!(matches!(
            decode_qr_image(b"not-an-image"),
            Err(AuthShareError::InvalidQrImage)
        ));
    }
}
