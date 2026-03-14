export interface ProjectTypeChecklist {
  requiredPages: string[];
  requiredDataModels: string[];
  requiredFeatures: string[];
  commonComponents: string[];
}

const TEMPLATES: Record<string, ProjectTypeChecklist> = {
  lms: {
    requiredPages: [
      'Home/Landing', 'Login', 'Register', 'Student Dashboard', 'Course Catalog',
      'Course Detail', 'Lesson Player', 'Student Progress', 'Student Profile',
      'Admin Dashboard', 'Admin Courses (CRUD)', 'Admin Students', 'Admin Instructors',
      'Settings', '404', 'Terms', 'Privacy',
    ],
    requiredDataModels: ['users', 'courses', 'lessons', 'enrollments', 'progress', 'categories'],
    requiredFeatures: ['Authentication', 'Course CRUD', 'Enrollment', 'Progress Tracking', 'Search/Filter'],
    commonComponents: ['Navbar', 'Footer', 'Sidebar', 'CourseCard', 'LessonList', 'ProgressBar', 'SearchBar'],
  },
  ecommerce: {
    requiredPages: [
      'Home', 'Login', 'Register', 'Product Catalog', 'Product Detail',
      'Shopping Cart', 'Checkout', 'Order Confirmation', 'Order History', 'Wishlist',
      'User Profile', 'Admin Dashboard', 'Admin Products (CRUD)', 'Admin Orders',
      'Admin Categories', 'Settings', '404', 'Terms', 'Privacy', 'Contact',
    ],
    requiredDataModels: ['users', 'products', 'categories', 'orders', 'order_items', 'cart_items', 'reviews'],
    requiredFeatures: ['Authentication', 'Product CRUD', 'Cart', 'Checkout', 'Order Management', 'Search/Filter', 'Reviews'],
    commonComponents: ['Navbar', 'Footer', 'ProductCard', 'CartSidebar', 'SearchBar', 'CategoryFilter', 'PriceFilter'],
  },
  crm: {
    requiredPages: [
      'Home/Landing', 'Login', 'Register', 'Dashboard', 'Contacts List',
      'Contact Detail', 'Deals/Pipeline', 'Deal Detail', 'Tasks', 'Activities',
      'Reports/Analytics', 'User Profile', 'Admin Users', 'Settings', '404',
    ],
    requiredDataModels: ['users', 'contacts', 'companies', 'deals', 'activities', 'tasks', 'notes', 'pipeline_stages'],
    requiredFeatures: ['Authentication', 'Contact CRUD', 'Deal Pipeline', 'Activity Tracking', 'Task Management', 'Search/Filter', 'Reports'],
    commonComponents: ['Navbar', 'Sidebar', 'PipelineBoard', 'ContactCard', 'DealCard', 'ActivityTimeline', 'SearchBar'],
  },
  website: {
    requiredPages: [
      'Home', 'About', 'Services', 'Contact', '404', 'Terms', 'Privacy',
    ],
    requiredDataModels: [],
    requiredFeatures: ['Contact Form', 'Responsive Navigation'],
    commonComponents: ['Navbar', 'Footer', 'Hero', 'ContactForm'],
  },
  landing: {
    requiredPages: ['Home/Landing', '404', 'Terms', 'Privacy'],
    requiredDataModels: [],
    requiredFeatures: ['CTA Sections', 'Responsive Navigation'],
    commonComponents: ['Navbar', 'Footer', 'Hero', 'CTASection', 'TestimonialCard'],
  },
  dashboard: {
    requiredPages: [
      'Login', 'Register', 'Dashboard', 'Analytics', 'User Profile',
      'Settings', 'Admin Users', '404',
    ],
    requiredDataModels: ['users', 'metrics', 'reports'],
    requiredFeatures: ['Authentication', 'Data Visualization', 'User Management', 'Settings'],
    commonComponents: ['Navbar', 'Sidebar', 'StatCard', 'Chart', 'DataTable'],
  },
  blog: {
    requiredPages: [
      'Home', 'Blog List', 'Blog Post Detail', 'About', 'Contact',
      'Admin Dashboard', 'Admin Posts (CRUD)', 'Admin Categories', 'Settings', '404', 'Terms', 'Privacy',
    ],
    requiredDataModels: ['users', 'posts', 'categories', 'tags', 'comments'],
    requiredFeatures: ['Authentication', 'Post CRUD', 'Comments', 'Search/Filter', 'Categories'],
    commonComponents: ['Navbar', 'Footer', 'PostCard', 'CommentSection', 'SearchBar', 'TagCloud'],
  },
  saas: {
    requiredPages: [
      'Landing Page', 'Pricing', 'Login', 'Register', 'Dashboard',
      'User Profile', 'Settings', 'Billing', 'Admin Dashboard', 'Admin Users',
      'Admin Analytics', '404', 'Terms', 'Privacy',
    ],
    requiredDataModels: ['users', 'subscriptions', 'plans', 'invoices', 'usage_metrics'],
    requiredFeatures: ['Authentication', 'Subscription Management', 'User Dashboard', 'Admin Panel', 'Analytics'],
    commonComponents: ['Navbar', 'Footer', 'Sidebar', 'PricingCard', 'StatCard', 'BillingForm'],
  },
  portfolio: {
    requiredPages: ['Home', 'Projects/Work', 'Project Detail', 'About', 'Contact', '404', 'Terms'],
    requiredDataModels: [],
    requiredFeatures: ['Project Gallery', 'Contact Form', 'Responsive Navigation'],
    commonComponents: ['Navbar', 'Footer', 'ProjectCard', 'ContactForm', 'Hero'],
  },
  marketplace: {
    requiredPages: [
      'Home', 'Login', 'Register', 'Browse/Search', 'Listing Detail',
      'Create Listing', 'User Profile', 'My Listings', 'Messages', 'Dashboard',
      'Admin Dashboard', 'Admin Listings', 'Admin Users', 'Settings', '404', 'Terms', 'Privacy',
    ],
    requiredDataModels: ['users', 'listings', 'categories', 'messages', 'reviews', 'transactions'],
    requiredFeatures: ['Authentication', 'Listing CRUD', 'Search/Filter', 'Messaging', 'Reviews', 'User Profiles'],
    commonComponents: ['Navbar', 'Footer', 'ListingCard', 'SearchBar', 'CategoryFilter', 'MessageThread'],
  },
  pwa: {
    requiredPages: [
      'Home', 'Login', 'Register', 'Dashboard', 'Settings', 'Profile',
      'Notifications', 'Offline', '404', 'Terms', 'Privacy',
    ],
    requiredDataModels: ['users', 'settings', 'notifications'],
    requiredFeatures: ['Authentication', 'Push Notifications', 'Offline Support', 'Install Prompt', 'Responsive Navigation'],
    commonComponents: ['Navbar', 'BottomNavigation', 'InstallBanner', 'OfflineBanner', 'PullToRefresh', 'Footer'],
  },
  restaurant: {
    requiredPages: [
      'Home/Landing', 'Menu', 'Menu Item Detail', 'Reservations', 'About',
      'Gallery', 'Contact', 'Order Online', 'Cart/Checkout', 'Order Confirmation',
      'Login', 'User Profile', 'Order History',
      'Admin Dashboard', 'Admin Menu (CRUD)', 'Admin Reservations', 'Admin Orders',
      'Settings', '404', 'Terms', 'Privacy',
    ],
    requiredDataModels: [
      'users', 'menu_categories', 'menu_items', 'reservations', 'orders',
      'order_items', 'reviews', 'gallery_images', 'restaurant_info',
    ],
    requiredFeatures: [
      'Authentication', 'Menu CRUD', 'Online Ordering', 'Reservation System',
      'Gallery', 'Contact Form', 'Order Tracking', 'Search/Filter', 'Reviews',
    ],
    commonComponents: [
      'Navbar', 'Footer', 'Hero', 'MenuCard', 'MenuCategoryNav', 'ReservationForm',
      'CartSidebar', 'GalleryGrid', 'ReviewCard', 'OrderStatusBadge', 'ContactMap',
    ],
  },
  clinica: {
    requiredPages: [
      'Home/Landing', 'Services', 'Service Detail', 'Doctors/Team', 'Doctor Profile',
      'Appointments', 'Book Appointment', 'Appointment Confirmation',
      'Patient Portal/Login', 'Patient Dashboard', 'Medical History', 'Prescriptions',
      'About', 'Contact', 'Testimonials', 'Blog/Health Tips',
      'Admin Dashboard', 'Admin Appointments', 'Admin Patients', 'Admin Doctors',
      'Admin Services (CRUD)', 'Settings', '404', 'Terms', 'Privacy',
    ],
    requiredDataModels: [
      'users', 'doctors', 'specialties', 'services', 'appointments', 'patients',
      'medical_records', 'prescriptions', 'testimonials', 'blog_posts', 'schedules',
    ],
    requiredFeatures: [
      'Authentication', 'Appointment Booking', 'Doctor Directory', 'Patient Portal',
      'Medical Records', 'Service CRUD', 'Schedule Management', 'Search/Filter',
      'Testimonials', 'Blog', 'Contact Form',
    ],
    commonComponents: [
      'Navbar', 'Footer', 'Hero', 'DoctorCard', 'ServiceCard', 'AppointmentForm',
      'CalendarPicker', 'TimeSlotGrid', 'PatientSidebar', 'TestimonialCarousel',
      'SpecialtyBadge', 'ContactMap',
    ],
  },
  inmobiliaria: {
    requiredPages: [
      'Home/Landing', 'Property Listing/Search', 'Property Detail', 'Map View',
      'Agents/Team', 'Agent Profile', 'Contact Agent', 'Property Comparison',
      'Favorites/Saved', 'Login', 'Register', 'User Profile',
      'Submit Property', 'My Properties',
      'About', 'Contact', 'Blog/News',
      'Admin Dashboard', 'Admin Properties (CRUD)', 'Admin Agents', 'Admin Inquiries',
      'Settings', '404', 'Terms', 'Privacy',
    ],
    requiredDataModels: [
      'users', 'properties', 'property_images', 'property_types', 'agents',
      'inquiries', 'favorites', 'neighborhoods', 'amenities', 'blog_posts',
    ],
    requiredFeatures: [
      'Authentication', 'Property CRUD', 'Advanced Search/Filter', 'Map Integration',
      'Property Comparison', 'Favorites', 'Inquiry System', 'Agent Directory',
      'Image Gallery', 'Blog', 'Contact Form', 'Responsive Navigation',
    ],
    commonComponents: [
      'Navbar', 'Footer', 'Hero', 'PropertyCard', 'PropertyGallery', 'SearchFilters',
      'MapView', 'AgentCard', 'InquiryForm', 'ComparisonTable', 'PriceRangeSlider',
      'AmenityBadge', 'NeighborhoodCard', 'FavoriteButton',
    ],
  },
  custom: {
    requiredPages: ['Home', 'Login', 'Dashboard', 'Settings', '404'],
    requiredDataModels: ['users'],
    requiredFeatures: ['Authentication', 'Responsive Navigation'],
    commonComponents: ['Navbar', 'Footer'],
  },
};

const ALIASES: Record<string, string> = {
  restaurante: 'restaurant',
  restaurantes: 'restaurant',
  clinic: 'clinica',
  medical: 'clinica',
  hospital: 'clinica',
  doctor: 'clinica',
  realestate: 'inmobiliaria',
  realstate: 'inmobiliaria',
  property: 'inmobiliaria',
  properties: 'inmobiliaria',
  bienes: 'inmobiliaria',
  bienesraices: 'inmobiliaria',
};

export function getProjectTemplate(projectType: string): ProjectTypeChecklist | null {
  const normalized = projectType.toLowerCase().replace(/[^a-z]/g, '');

  if (ALIASES[normalized]) {
    return TEMPLATES[ALIASES[normalized]] || null;
  }

  for (const [key, template] of Object.entries(TEMPLATES)) {
    if (normalized.includes(key) || key.includes(normalized)) {
      return template;
    }
  }

  for (const [alias, key] of Object.entries(ALIASES)) {
    if (normalized.includes(alias)) {
      return TEMPLATES[key] || null;
    }
  }

  return null;
}

export function findMissingPages(
  architecturePages: string[],
  checklist: ProjectTypeChecklist
): string[] {
  const normalizedExisting = new Set(
    architecturePages.map((p) => p.toLowerCase().replace(/[^a-z0-9]/g, ''))
  );

  return checklist.requiredPages.filter((required) => {
    const normalized = required.toLowerCase().replace(/[^a-z0-9]/g, '');
    const variants = required.split('/').map((v) => v.trim().toLowerCase().replace(/[^a-z0-9]/g, ''));
    return !variants.some((v) => normalizedExisting.has(v)) && !normalizedExisting.has(normalized);
  });
}

export function findMissingModels(
  architectureModels: string[],
  checklist: ProjectTypeChecklist
): string[] {
  const normalizedExisting = new Set(
    architectureModels.map((m) => m.toLowerCase().replace(/[^a-z0-9]/g, ''))
  );

  return checklist.requiredDataModels.filter((required) => {
    const normalized = required.toLowerCase().replace(/[^a-z0-9]/g, '');
    return !normalizedExisting.has(normalized);
  });
}

export function getAllTemplateTypes(): string[] {
  return Object.keys(TEMPLATES);
}
