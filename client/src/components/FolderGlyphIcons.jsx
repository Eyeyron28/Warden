import {
  Airplane,
  BookOpen,
  Briefcase,
  Camera,
  Car,
  FolderSimple,
  GraduationCap,
  Heart,
  House,
  IdentificationCard,
  Receipt,
  ShieldCheck,
} from '@phosphor-icons/react';

const ICONS = {
  folder: FolderSimple,
  'id-card': IdentificationCard,
  heart: Heart,
  home: House,
  'graduation-cap': GraduationCap,
  receipt: Receipt,
  briefcase: Briefcase,
  plane: Airplane,
  car: Car,
  shield: ShieldCheck,
  camera: Camera,
  book: BookOpen,
};

function FolderGlyphIcons({ icon, size, weight, className, style }) {
  const Icon = ICONS[icon] || FolderSimple;
  return <Icon size={size} weight={weight} className={className} style={style} aria-hidden="true" />;
}

export default FolderGlyphIcons;
