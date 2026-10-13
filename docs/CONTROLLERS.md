# Wheel, pedals and controller setup

Apex accepts devices exposed by the browser's Gamepad API. Steering, pedals,
paddles, ERS/boost, camera, reset and pause are configurable. The intended setup
is a consumer Logitech G29/G920/G923-class wheel with its pedals plugged into
the wheel, on macOS Chrome. Two identical wheels can be assigned independently
to the two split-screen players. Separate USB pedals are an optional extension.

Compatibility depends on the operating-system driver and browser exposing the
hardware. The automated tests use synthetic devices. No physical wheel or
pedal hardware was available for validation; support on a particular Mac and
wheel combination remains unverified. The game does not implement
wheel force feedback, clutch simulation, H-pattern shifting or wheel-display LEDs.

## First setup

1. Install/configure the device manufacturer's driver and connect the hardware.
   Set the wheel's desired rotation range in that driver before calibrating.
2. Open **Options → Controls → Wheels & controllers**. Press a device button if
   it is not listed. Choose **Wheel**, **Gamepad** or **Pedals** for each device;
   this is particularly important for hardware with an unfamiliar device name.
3. Assign the wheel under **Player 1 steering / buttons**. If the pedals appear as
   another device, expand **Optional separate USB pedals**, choose that device
   under **Player 1 separate pedals** and set
   its type to **Pedals**. Use the corresponding Player 2 fields for split screen.
4. Select **Calibrate** on the wheel. Start centred, turn fully **left first**,
   then fully right, return to centre, and select Next. Press and release each
   pedal separately, then bind the two paddles, camera and pause.
5. If using separate pedals, their own **Calibrate** sequence contains only
   throttle and brake. Pedals can be axes (including inverted/combined axes) or
   analogue buttons. Leave each pedal released when its step starts.
6. Expand **Tune / test controls**. Confirm centre reads 0%, left/right reach
   −100%/+100%, released pedals read 0%, and fully pressed pedals read 100%.
7. Bind **ERS / boost**, **Reset to track**, **Look back** and **Handbrake** as
   desired. Select Bind, then press the intended button. One physical button is
   assigned to one listed action; Clear disables a mapping.
8. Choose automatic transmission or manual transmission in **Assists & units**.
   Start a practice drive with no AI to verify the hardware before racing.

Profiles and player assignments are saved with the game profile. Exporting a save
includes the controller settings. Two connected wheels with identical names have
independent assignments and calibration profiles, distinguished by browser
Gamepad index. Unplugging one does not renumber the other. The Gamepad API does
not supply a hardware serial number: if the OS/browser changes device indices
after moving USB ports or reconnecting, recheck and reassign the numbered entries.
Legacy profiles keyed only by device ID remain readable.

## Steering and pedals

- **Direct wheel steering** uses the vehicle's full steering lock at every speed
  and bypasses input/steering smoothing. This preserves physical wheel control.
  Turn it off for the game's speed-sensitive steering assistance. ABS, traction
  control and stability control remain separate settings.
- **Steering deadzone** removes centre jitter. Wheels default to 1.5%; pads use
  the global controller deadzone unless overridden for that device.
- **Steering curve** defaults to 1.00 (linear). Values above 1 soften the centre;
  values below 1 make it more sensitive.
- **Travel to full lock** reduces the calibrated travel needed to reach full
  steering. At 100%, the calibrated end stop is full lock.
- **Set current position as centre** corrects an off-centre wheel without
  repeating the entire wizard. Invert steering corrects reversed movement.
- **Pedal deadzone** removes slight input when released. **Pedal travel / force
  for 100%** lets a shorter travel or lighter pedal press reach full output.
  Calibration also records the observed analogue-button range.
- Separate USB pedals own throttle/brake when assigned, so unused wheel-base
  pedal axes cannot apply a phantom brake. If the separate set disappears,
  its outputs become zero instead of falling back to uncalibrated wheel axes.

Disconnecting an assigned driving device requests a race pause. Reconnect and
resume explicitly. The same wheel/pad pause button works for both pause and
resume. Finishing calibration or a button binding requires releasing held action
buttons before those buttons can trigger in-game actions.

## Troubleshooting

| Symptom | Check |
|---|---|
| Device absent | Press a button, check the OS driver, and try a browser that exposes the hardware through Gamepad API. A saved disconnected assignment remains visible. |
| Accelerator/brake held at rest | Calibrate with pedals released at the start of each step; inspect the meters, mapping and inversion. |
| Pedals move the camera or trigger boost | Mark the USB pedal device as Pedals, then assign it under separate pedals. |
| Wheel buttons accelerate the car | Mark the device as Wheel instead of Gamepad; gamepad face-button driving shortcuts are disabled for wheels. |
| Steering drifts or is reversed | Capture the centre, check Invert steering, then adjust the deadzone. |
| Steering too abrupt at speed | Reduce wheel movement, adjust the curve/travel, or disable Direct wheel steering. |
| Paddle does not shift | Select Manual transmission and check the shift binding. |
| No force feedback | Force-feedback output is not implemented; calibration only configures input. |

## Extending input support

`src/game/input/Gamepads.ts` defines the serializable `DeviceProfile`, pure
`readDevice` mapping and `Calibrator`. Add new optional profile fields with safe
fallbacks so older saves keep working. `ButtonMap` and `AxisMap` both support raw
rest/full ranges. Steering adds a separately captured centre.

`src/game/input/InputManager.ts` resolves primary/pedal assignments, combines
inputs into `InputState`, and emits discrete `input:action` edges. The engine
forwards `directSteering` to each human car and handles `controllerDisconnected`
by pausing an active race. New hardware transports should feed this boundary;
they should not change vehicle or track implementations.

The UI lives in `src/ui/components/DevicePanel.tsx`. `BUTTON_LABELS` is the source
for the action-binding list. The controls settings store primary and pedal
assignments independently. Family photos and billboard placement are unrelated
to controller profiles and remain unchanged by controller setup.

Run `node tests/controller-regressions.mjs` for pure mapping, calibration,
assignment, pause/resume, binding-edge and disconnect regressions. Run the full
`npm test` suite for browser calibration, driving, split-screen and billboard
coverage. Synthetic tests validate software routing, not a particular USB device.
