//go:build twilio_unsigned

package main

// unsignedTwilioAllowed lets SKIP_TWILIO_SIGNATURE=true accept unsigned
// Twilio webhooks. It is true only in a binary built with
// `-tags twilio_unsigned`, for local experiments against a fake Twilio.
// `make build-rest-api` and every deploy build without the tag (#696).
const unsignedTwilioAllowed = true
