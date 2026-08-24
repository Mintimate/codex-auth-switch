use base64::{engine::general_purpose::STANDARD, Engine as _};
use flate2::{read::ZlibDecoder, write::ZlibEncoder, Compression};
use image::{DynamicImage, ImageFormat, ImageReader, Luma};
use qrcode::{EcLevel, QrCode};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    fmt,
    io::{Cursor, Read, Write},
};

const SHARE_VERSION: u32 = 1;
const SHARE_TEXT_PREFIX: &str = "CAS-AUTH:1:";
const BASE45_ALPHABET: &[u8; 45] = b"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:";
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
            Self::InvalidPayload => "分享内容无效或已损坏",
            Self::PayloadTooLarge => "分享内容超过允许大小",
            Self::QrTooLarge => "此账号的分享内容超过单个二维码容量，请改用剪贴板",
            Self::InvalidQrImage => "二维码图片无效或尺寸过大",
            Self::QrNotFound => "图片中未识别到有效的 Auth 分享二维码",
            Self::RenderFailed => "生成分享二维码失败",
        })
    }
}

impl std::error::Error for AuthShareError {}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AuthShareEnvelope {
    version: u32,
    label: String,
    auth: Value,
    created_at: u64,
}

#[derive(Debug, Clone)]
pub(crate) struct ImportedAuth {
    pub label: String,
    pub auth: Value,
}

pub(crate) fn encode_text(
    label: &str,
    auth: &Value,
    created_at: u64,
) -> Result<String, AuthShareError> {
    let envelope = AuthShareEnvelope {
        version: SHARE_VERSION,
        label: label.to_string(),
        auth: auth.clone(),
        created_at,
    };
    let json = serde_json::to_vec(&envelope).map_err(|_| AuthShareError::InvalidPayload)?;
    if json.len() > MAX_ENVELOPE_BYTES {
        return Err(AuthShareError::PayloadTooLarge);
    }

    let mut encoder = ZlibEncoder::new(Vec::new(), Compression::best());
    encoder
        .write_all(&json)
        .map_err(|_| AuthShareError::InvalidPayload)?;
    let compressed = encoder
        .finish()
        .map_err(|_| AuthShareError::InvalidPayload)?;
    Ok(format!("{SHARE_TEXT_PREFIX}{}", base45_encode(&compressed)))
}

pub(crate) fn decode_text(text: &str) -> Result<ImportedAuth, AuthShareError> {
    let text = text.trim();
    if text.len() > MAX_SHARE_TEXT_BYTES {
        return Err(AuthShareError::PayloadTooLarge);
    }
    let encoded = text
        .strip_prefix(SHARE_TEXT_PREFIX)
        .ok_or(AuthShareError::InvalidPayload)?;
    let compressed = base45_decode(encoded)?;
    let decoder = ZlibDecoder::new(compressed.as_slice());
    let mut json = Vec::new();
    decoder
        .take((MAX_ENVELOPE_BYTES + 1) as u64)
        .read_to_end(&mut json)
        .map_err(|_| AuthShareError::InvalidPayload)?;
    if json.len() > MAX_ENVELOPE_BYTES {
        return Err(AuthShareError::PayloadTooLarge);
    }
    let envelope: AuthShareEnvelope =
        serde_json::from_slice(&json).map_err(|_| AuthShareError::InvalidPayload)?;
    if envelope.version != SHARE_VERSION {
        return Err(AuthShareError::InvalidPayload);
    }
    Ok(ImportedAuth {
        label: envelope.label,
        auth: envelope.auth,
    })
}

fn base45_encode(bytes: &[u8]) -> String {
    let mut encoded = String::with_capacity((bytes.len() * 3).div_ceil(2));
    for chunk in bytes.chunks(2) {
        let value = if chunk.len() == 2 {
            u16::from_be_bytes([chunk[0], chunk[1]]) as usize
        } else {
            chunk[0] as usize
        };
        encoded.push(BASE45_ALPHABET[value % 45] as char);
        encoded.push(BASE45_ALPHABET[(value / 45) % 45] as char);
        if chunk.len() == 2 {
            encoded.push(BASE45_ALPHABET[value / (45 * 45)] as char);
        }
    }
    encoded
}

fn base45_decode(encoded: &str) -> Result<Vec<u8>, AuthShareError> {
    if encoded.len() % 3 == 1 || !encoded.is_ascii() {
        return Err(AuthShareError::InvalidPayload);
    }
    let values = encoded
        .bytes()
        .map(|byte| {
            BASE45_ALPHABET
                .iter()
                .position(|candidate| *candidate == byte)
                .ok_or(AuthShareError::InvalidPayload)
        })
        .collect::<Result<Vec<_>, _>>()?;
    let mut decoded = Vec::with_capacity((values.len() * 2) / 3 + 1);
    for chunk in values.chunks(3) {
        let value = chunk[0] + chunk[1] * 45 + chunk.get(2).copied().unwrap_or(0) * 45 * 45;
        if chunk.len() == 3 {
            let value = u16::try_from(value).map_err(|_| AuthShareError::InvalidPayload)?;
            decoded.extend_from_slice(&value.to_be_bytes());
        } else {
            decoded.push(u8::try_from(value).map_err(|_| AuthShareError::InvalidPayload)?);
        }
    }
    Ok(decoded)
}

pub(crate) fn render_qr_data_url(text: &str) -> Result<String, AuthShareError> {
    let code = QrCode::with_error_correction_level(text.as_bytes(), EcLevel::L)
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
        let Ok(text) = String::from_utf8(content) else {
            continue;
        };
        if let Ok(imported) = decode_text(&text) {
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
            }
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
                "id_token": format!("{}.{}.{}", noisy_text(36, 1), noisy_text(900, 2), noisy_text(342, 3)),
                "access_token": format!("{}.{}.{}", noisy_text(36, 4), noisy_text(700, 5), noisy_text(342, 6)),
                "refresh_token": noisy_text(110, 7),
                "account_id": "account-a"
            }
        })
    }

    #[test]
    fn text_share_round_trips_without_plain_json() {
        let encoded = encode_text("个人账号", &sample_auth(), 123).unwrap();
        assert!(encoded.starts_with(SHARE_TEXT_PREFIX));
        assert!(!encoded.contains("refresh-token"));

        let decoded = decode_text(&encoded).unwrap();
        assert_eq!(decoded.label, "个人账号");
        assert_eq!(decoded.auth, sample_auth());
    }

    #[test]
    fn qr_share_round_trips_through_png() {
        let auth = realistic_sized_auth();
        let text = encode_text("个人账号", &auth, 123).unwrap();
        let data_url = render_qr_data_url(&text).unwrap();
        let png = STANDARD
            .decode(data_url.strip_prefix("data:image/png;base64,").unwrap())
            .unwrap();
        let decoded = decode_qr_image(&png).unwrap();
        assert_eq!(decoded.label, "个人账号");
        assert_eq!(decoded.auth, auth);
    }

    #[test]
    fn base45_round_trips_binary_values() {
        for value in [
            Vec::new(),
            vec![0],
            vec![0, 255],
            (0..=255).collect::<Vec<u8>>(),
        ] {
            assert_eq!(base45_decode(&base45_encode(&value)).unwrap(), value);
        }
    }

    #[test]
    fn rejects_unrecognized_text_and_images() {
        assert!(matches!(
            decode_text("not-a-share"),
            Err(AuthShareError::InvalidPayload)
        ));
        assert!(matches!(
            decode_qr_image(b"not-an-image"),
            Err(AuthShareError::InvalidQrImage)
        ));
    }
}
