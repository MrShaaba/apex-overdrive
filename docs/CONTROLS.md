# Controls

## Keyboard
| Key | Action |
|---|---|
| W / ↑ | Throttle |
| S / ↓ | Brake (hold at standstill for reverse) |
| A / D, ← / → | Steer |
| Space | Handbrake |
| Shift | Nitrous |
| Q / E | Gear down / up (manual transmission) |
| C | Cycle camera (chase → far chase → hood → cockpit → cinematic) |
| B | Look back |
| R | Reset to track |
| F | Photo mode |
| V | Replay (after the finish) |
| N | Toggle HUD |
| L | (reserved) headlights |
| Tab | (reserved) live standings |
| Esc / P | Pause |
| Mouse drag | Orbit chase camera / rotate showcase car; wheel zooms in photo mode |

## Gamepad (standard mapping)
Left stick steer · RT throttle · LT brake · A throttle (digital) · X brake · B handbrake ·
stick up or L3 nitrous · stick down look back · Y camera · LB/RB gears · Start pause ·
Select reset · right stick orbits the camera.

## Racing wheels and several controllers
Any number of gamepads and wheels can be connected; each feeds one player. Player 1 gets
the keyboard plus the first free pad, player 2 the second pad (or the keyboard, when set
so in Options → Controls → Wheels & controllers). Assignments and calibrations are saved
per device id.

Racing wheels (Logitech G29 / G920 / G923, Thrustmaster, Fanatec…) show up through the
Gamepad API with steering on one axis and each pedal on its own axis, often resting at +1
and pressed to −1. Press **Calibrate** next to the device and follow the steps: turn the
wheel lock to lock and let it centre, press the throttle, press the brake, then press the
button or paddle you want for shift up, shift down, camera and pause. The saved profile
maps the raw ranges (inverted or split ranges included) to the game's 0..1 controls.
A wheel that has not been calibrated uses a Logitech-style default map (wheel on axis 0,
pedals on axes 2 and 3, paddles on buttons 4 and 5).

Force feedback is not exposed to browsers, so wheels run without it.

## Touch
Buttons layout: ◀ ▶ steer, GAS, BRAKE, E-BRK, NOS, CAM, RESET, pause.
Tilt layout: hold the phone in landscape and tilt to steer; GAS/BRAKE remain on screen.
Sensitivity in Options → Controls.

## Assists (Options → Controls)
ABS, traction control and stability control can be toggled; automatic or manual gearbox;
km/h or mph.
