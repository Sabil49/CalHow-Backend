import { describe, expect, it } from 'vitest';
import { detectImageMimeType } from '../validation';

// A 1x1 real PNG and a 1x1 real JPEG, base64-encoded — small, known-good
// fixtures rather than hand-rolled fake headers, so the test exercises
// the same decode path as a real upload.
const PNG_1X1_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const JPEG_1X1_BASE64 =
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/2wBDAQMDAwQDBAgEBAgQCwkLEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBD/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAj/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCdABmX/9k=';

describe('detectImageMimeType', () => {
  it('detects a real PNG from its magic bytes', () => {
    expect(detectImageMimeType(PNG_1X1_BASE64)).toBe('image/png');
  });

  it('detects a real JPEG from its magic bytes', () => {
    expect(detectImageMimeType(JPEG_1X1_BASE64)).toBe('image/jpeg');
  });

  it('detects JPEG bytes even when mislabeled as PNG by the caller (the reported bug)', () => {
    // The detector only looks at bytes — it has no idea what the caller
    // claims the type is. This is the exact scenario from the Anthropic
    // 400 error ("specified using image/png... appears to be image/jpeg").
    expect(detectImageMimeType(JPEG_1X1_BASE64)).not.toBe('image/png');
    expect(detectImageMimeType(JPEG_1X1_BASE64)).toBe('image/jpeg');
  });

  it('returns null for an unrecognized format', () => {
    expect(detectImageMimeType(Buffer.from('not an image').toString('base64'))).toBeNull();
  });

  it('returns null for empty or malformed base64 rather than throwing', () => {
    expect(detectImageMimeType('')).toBeNull();
    expect(detectImageMimeType('!!!not-base64!!!')).toBeNull();
  });
});
