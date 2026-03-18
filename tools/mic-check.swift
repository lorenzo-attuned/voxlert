// mic-check.swift — Prints "active" if the default audio input device is running, "inactive" otherwise.
// Compile: swiftc -O tools/mic-check.swift -o ~/.voxlert/mic-check
import CoreAudio
import Foundation

var defaultAddress = AudioObjectPropertyAddress(
    mSelector: kAudioHardwarePropertyDefaultInputDevice,
    mScope: kAudioObjectPropertyScopeGlobal,
    mElement: kAudioObjectPropertyElementMain
)

var deviceID: AudioDeviceID = 0
var size = UInt32(MemoryLayout<AudioDeviceID>.size)

let status = AudioObjectGetPropertyData(
    AudioObjectID(kAudioObjectSystemObject),
    &defaultAddress, 0, nil, &size, &deviceID
)

guard status == noErr, deviceID != 0 else {
    print("inactive")
    exit(0)
}

var runningAddress = AudioObjectPropertyAddress(
    mSelector: kAudioDevicePropertyDeviceIsRunningSomewhere,
    mScope: kAudioObjectPropertyScopeInput,
    mElement: kAudioObjectPropertyElementMain
)

var isRunning: UInt32 = 0
size = UInt32(MemoryLayout<UInt32>.size)

let runStatus = AudioObjectGetPropertyData(deviceID, &runningAddress, 0, nil, &size, &isRunning)

print(runStatus == noErr && isRunning != 0 ? "active" : "inactive")
