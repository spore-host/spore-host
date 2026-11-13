//go:build !twilio_unsigned

package main

// unsignedTwilioAllowed is false in every deployed build: the Twilio webhook
// always requires a valid signature (#696). See twilio_unsigned.go.
const unsignedTwilioAllowed = false
